import ScreenCaptureKit
import CoreMedia
import AVFAudio
import CoreGraphics
import Foundation
import AppKit
import CoreAudio
import AudioToolbox
import IOKit.pwr_mgt

// MARK: - Constants

/// Minimum peak amplitude to consider microphone audio "loud" (silence timeout).
private let kMicLoudThreshold: Float = 1e-2
/// Minimum peak amplitude to consider system audio "loud" (silence timeout).
private let kSystemLoudThreshold: Float = 1e-4

// LOCAL PATCH (5): mic gate. On speakers the mic re-captures the system audio 30–100 ms late
// (output + input latency; varies with devices and OS updates), so the merged file carried a
// second delayed copy of every remote word. At merge time the mic track is muted wherever the
// system track is loud — remote speech then comes only from the clean system tap. Runs offline,
// touches nothing on the live audio path (voice-processing AEC broke the mic for Teams).
// ponytail: fixed threshold + half-duplex gate; a real AEC (NLMS against the system track) if
// interjections over the remote party turn out to matter.
private let kMicGateBlockFrames = 480          // 20 ms at 24 kHz
private let kMicGateThresholdRMS: Float = 0.01 // -40 dBFS on the system track
private let kMicGatePreBlocks = 3              // 60 ms before system audio starts
private let kMicGateHangBlocks = 15            // 300 ms after it stops (covers echo lag + room)

/// Per-20 ms-block "system audio is loud" map over the system file, dilated for pre-roll/hangover.
func micGateMap(_ file: AVAudioFile) throws -> [Bool] {
    let blocks = Int((file.length + Int64(kMicGateBlockFrames) - 1) / Int64(kMicGateBlockFrames))
    var loud = [Bool](repeating: false, count: blocks)
    file.framePosition = 0
    let cap = AVAudioFrameCount(kMicGateBlockFrames * 512)
    guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: cap) else { return loud }
    let ch = Int(file.processingFormat.channelCount)
    var block = 0
    while file.framePosition < file.length {
        try file.read(into: buf, frameCount: cap)
        let n = Int(buf.frameLength); guard n > 0, let data = buf.floatChannelData else { break }
        var i = 0
        while i < n && block < blocks {
            let end = min(i + kMicGateBlockFrames, n)
            var sumsq: Float = 0
            for j in i..<end { var m: Float = 0; for c in 0..<ch { m += data[c][j] }; m /= Float(ch); sumsq += m * m }
            if (sumsq / Float(end - i)).squareRoot() > kMicGateThresholdRMS { loud[block] = true }
            block += 1; i = end
        }
    }
    var gate = loud
    for (b, isLoud) in loud.enumerated() where isLoud {
        for d in max(0, b - kMicGatePreBlocks)...min(blocks - 1, b + kMicGateHangBlocks) { gate[d] = true }
    }
    file.framePosition = 0
    return gate
}
/// System audio capture and merge output sample rate (mono float32).
private let kSystemAudioSampleRate: Double = 24000

/// Compute peak amplitude across all channels of float audio data.
func computePeakLevel(in channelData: UnsafePointer<UnsafeMutablePointer<Float>>,
               channels: Int, frames: Int) -> Float {
    var peak: Float = 0
    for ch in 0..<channels {
        for i in 0..<frames {
            let v = abs(channelData[ch][i])
            if v > peak { peak = v }
        }
    }
    return peak
}

// MARK: - Mic Capture via AVAudioEngine

class MicCapture {
    private let engine = AVAudioEngine()
    private var audioFile: AVAudioFile?
    private(set) var startHostTime: UInt64 = 0

    // Mute support — guarded by os_unfair_lock (tap callback is on AVAudioEngine thread)
    private var _isMuted = false
    private var _muteLock = os_unfair_lock_s()

    // Level tracking for silence timeout (mirrors SystemAudioCapture pattern)
    private var _lastLoudTime: UInt64 = DispatchTime.now().uptimeNanoseconds
    private var _lastLoudTimeLock = os_unfair_lock_s()

    var lastLoudTime: UInt64 {
        os_unfair_lock_lock(&_lastLoudTimeLock)
        defer { os_unfair_lock_unlock(&_lastLoudTimeLock) }
        return _lastLoudTime
    }

    var isMuted: Bool {
        os_unfair_lock_lock(&_muteLock)
        defer { os_unfair_lock_unlock(&_muteLock) }
        return _isMuted
    }

    func toggleMute() {
        os_unfair_lock_lock(&_muteLock)
        _isMuted.toggle()
        let muted = _isMuted
        os_unfair_lock_unlock(&_muteLock)
        fputs(muted ? "[MIC_MUTED]\n" : "[MIC_UNMUTED]\n", stderr)
    }

    func start(outputPath: String, deviceName: String?) throws {
        let input = engine.inputNode

        // If deviceName specified, find and set the audio device
        if let name = deviceName {
            let deviceID = try findInputDevice(named: name)
            var id = deviceID
            let err = AudioUnitSetProperty(
                input.audioUnit!,
                kAudioOutputUnitProperty_CurrentDevice,
                kAudioUnitScope_Global, 0,
                &id, UInt32(MemoryLayout<AudioDeviceID>.size))
            if err != noErr {
                throw MicError.cannotSetDevice(name)
            }
        }

        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            throw MicError.noInputAvailable
        }

        let url = URL(fileURLWithPath: outputPath)
        audioFile = try AVAudioFile(forWriting: url,
                                     settings: format.settings,
                                     commonFormat: .pcmFormatFloat32,
                                     interleaved: true)

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, time in
            guard let self else { return }
            if self.startHostTime == 0 {
                self.startHostTime = time.hostTime
            }
            let muted = self.isMuted
            if muted, let channelData = buffer.floatChannelData {
                let channels = Int(buffer.format.channelCount)
                let frames = Int(buffer.frameLength)
                for ch in 0..<channels {
                    memset(channelData[ch], 0, frames * MemoryLayout<Float>.size)
                }
            }
            // Track peak level for silence timeout (muted mic = silence)
            if !muted, let channelData = buffer.floatChannelData {
                let peak = computePeakLevel(in: channelData,
                                     channels: Int(buffer.format.channelCount),
                                     frames: Int(buffer.frameLength))
                if peak > kMicLoudThreshold {
                    os_unfair_lock_lock(&self._lastLoudTimeLock)
                    self._lastLoudTime = DispatchTime.now().uptimeNanoseconds
                    os_unfair_lock_unlock(&self._lastLoudTimeLock)
                }
            }
            do {
                try self.audioFile?.write(from: buffer)
            } catch {
                fputs("Mic write error: \(error)\n", stderr)
            }
        }
        try engine.start()
        fputs("Recording microphone audio to \(outputPath)...\n", stderr)
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        audioFile = nil
    }

    enum MicError: Error, CustomStringConvertible {
        case deviceNotFound(String)
        case cannotSetDevice(String)
        case noInputAvailable

        var description: String {
            switch self {
            case .deviceNotFound(let n): return "Input device not found: \(n)"
            case .cannotSetDevice(let n): return "Cannot set input device: \(n)"
            case .noInputAvailable: return "No audio input available (sample rate is 0)"
            }
        }
    }
}

/// Find an input audio device by name, returning its AudioDeviceID.
func findInputDevice(named name: String) throws -> AudioDeviceID {
    var propAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    var dataSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                    &propAddress, 0, nil, &dataSize)
    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                &propAddress, 0, nil, &dataSize, &devices)

    for deviceID in devices {
        // Get device name
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfNameRef: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &nameSize, &cfNameRef)
        let deviceName = cfNameRef?.takeRetainedValue() as String? ?? "(unknown)"

        // Check input channel count
        var inputAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var bufSize: UInt32 = 0
        AudioObjectGetPropertyDataSize(deviceID, &inputAddr, 0, nil, &bufSize)
        if bufSize > 0 {
            let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
            defer { bufferList.deallocate() }
            AudioObjectGetPropertyData(deviceID, &inputAddr, 0, nil, &bufSize, bufferList)
            let inputChannels = UnsafeMutableAudioBufferListPointer(bufferList)
                .reduce(0) { $0 + Int($1.mNumberChannels) }
            if inputChannels > 0 && deviceName.lowercased().contains(name.lowercased()) {
                return deviceID
            }
        }
    }
    throw MicCapture.MicError.deviceNotFound(name)
}

// MARK: - System Audio Capture via ScreenCaptureKit

class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, SCContentSharingPickerObserver {
    private var stream: SCStream?
    private var audioFile: AVAudioFile?
    private var audioConverter: AVAudioConverter?
    private let captureQueue = DispatchQueue(label: "com.ownscribe.audioCapture", qos: .userInitiated)

    private let outputPath: String

    // Timestamp for sync alignment
    private(set) var startHostTime: UInt64 = 0

    // Silence detection
    private var peakLevel: Float = 0.0
    private var totalFrames: Int64 = 0
    private var silenceChecked: Bool = false
    private var silenceWarned: Bool = false

    // Silence timeout auto-stop
    var silenceTimeout: TimeInterval = 0  // seconds; 0 = disabled
    var onSilenceTimeout: (() -> Void)?
    var micCapture: MicCapture?  // checked by silence timer
    private var lastLoudTime: UInt64 = DispatchTime.now().uptimeNanoseconds
    private var lastLoudTimeLock = os_unfair_lock_s()
    private var silenceTimer: DispatchSourceTimer?

    // Power assertion to prevent display sleep during capture
    private var powerAssertionID: IOPMAssertionID = IOPMAssertionID(kIOPMNullAssertionID)

    // Picker continuation
    private var startContinuation: CheckedContinuation<Void, Error>?

    init(outputPath: String) {
        self.outputPath = outputPath
        super.init()
    }

    var captureModeAll: Bool = false

    func start() async throws {
        if captureModeAll {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                throw CaptureError.noDisplay
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            try await self.beginCapture(with: filter)
        } else {
            let picker = SCContentSharingPicker.shared
            var pickerConfig = SCContentSharingPickerConfiguration()
            pickerConfig.allowedPickerModes = [.singleWindow, .singleDisplay, .singleApplication]
            picker.defaultConfiguration = pickerConfig
            picker.add(self)
            picker.isActive = true
            picker.present()

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.startContinuation = continuation
            }
        }
    }

    // MARK: - SCContentSharingPickerObserver

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task {
            do {
                try await self.beginCapture(with: filter)
                self.startContinuation?.resume()
                self.startContinuation = nil
            } catch {
                self.startContinuation?.resume(throwing: error)
                self.startContinuation = nil
            }
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        fputs("Content picker cancelled.\n", stderr)
        exit(0)
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        self.startContinuation?.resume(throwing: error)
        self.startContinuation = nil
    }

    // MARK: - Begin Capture

    private func beginCapture(with filter: SCContentFilter) async throws {
        // Configure stream (audio only, minimal video)
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(kSystemAudioSampleRate)
        config.channelCount = 1
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        // Create AVAudioFile for WAV output (interleaved to avoid CoreAudio warning)
        let fileFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: kSystemAudioSampleRate, channels: 1, interleaved: true)!
        let audioFile = try AVAudioFile(forWriting: URL(fileURLWithPath: outputPath),
                                         settings: fileFormat.settings,
                                         commonFormat: .pcmFormatFloat32,
                                         interleaved: true)
        self.audioFile = audioFile

        // Create and start stream
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: captureQueue)

        // Initialize last-loud time before starting capture (no lock needed — callbacks haven't started)
        if silenceTimeout > 0 {
            lastLoudTime = DispatchTime.now().uptimeNanoseconds
        }

        try await stream.startCapture()
        self.stream = stream

        IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "ownscribe is recording audio" as CFString,
            &powerAssertionID)

        fputs("Recording system audio to \(outputPath)... Press Ctrl+C to stop.\n", stderr)

        // Start silence timeout timer if configured.
        // Checks every 1s whether both system audio and mic (if active) have been
        // quiet longer than silenceTimeout. Uses the most recent "loud" timestamp
        // from either source so that activity on either channel prevents auto-stop.
        if silenceTimeout > 0 {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + 1, repeating: 1.0)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                let now = DispatchTime.now().uptimeNanoseconds
                os_unfair_lock_lock(&self.lastLoudTimeLock)
                var effectiveLastLoud = self.lastLoudTime
                os_unfair_lock_unlock(&self.lastLoudTimeLock)
                // If mic is active, use the more recent of the two
                if let mic = self.micCapture {
                    let micLastLoud = mic.lastLoudTime
                    if micLastLoud > effectiveLastLoud {
                        effectiveLastLoud = micLastLoud
                    }
                }
                guard now >= effectiveLastLoud else { return }
                let elapsed = Double(now - effectiveLastLoud) / 1_000_000_000.0
                if elapsed > self.silenceTimeout {
                    fputs("[SILENCE_TIMEOUT]\n", stderr)
                    self.silenceTimer?.cancel()
                    self.silenceTimer = nil
                    self.onSilenceTimeout?()
                }
            }
            timer.resume()
            silenceTimer = timer
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let audioFile else { return }
        guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }

        // Capture start host time from first audio buffer
        if startHostTime == 0 {
            startHostTime = mach_absolute_time()
        }

        // Get format from sample buffer
        guard let formatDesc = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        guard let sampleFormat = AVAudioFormat(streamDescription: asbd) else { return }

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: sampleFormat, frameCapacity: frameCount) else { return }
        pcmBuffer.frameLength = frameCount

        // Copy audio data into PCM buffer
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frameCount),
            into: pcmBuffer.mutableAudioBufferList
        )
        guard status == noErr else { return }

        // Convert non-interleaved → interleaved if needed, then write
        do {
            if sampleFormat.isInterleaved {
                try audioFile.write(from: pcmBuffer)
            } else {
                if audioConverter?.inputFormat != sampleFormat {
                    let interleavedFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                                       sampleRate: sampleFormat.sampleRate,
                                                       channels: sampleFormat.channelCount,
                                                       interleaved: true)!
                    audioConverter = AVAudioConverter(from: sampleFormat, to: interleavedFmt)
                }
                if let converter = audioConverter {
                    let outFmt = converter.outputFormat
                    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: frameCount) else { return }
                    try converter.convert(to: outBuffer, from: pcmBuffer)
                    try audioFile.write(from: outBuffer)
                }
            }
        } catch {
            fputs("Write error: \(error)\n", stderr)
        }

        totalFrames += Int64(frameCount)

        // Peak detection on the pre-conversion buffer — floatChannelData returns nil
        // for interleaved buffers, so we must use the original SCK buffer
        let bufferPeak: Float = pcmBuffer.floatChannelData.map {
            computePeakLevel(in: $0, channels: Int(pcmBuffer.format.channelCount), frames: Int(pcmBuffer.frameLength))
        } ?? 0.0
        if bufferPeak > self.peakLevel { self.peakLevel = bufferPeak }

        // Update last loud time for silence timeout
        if bufferPeak > kSystemLoudThreshold {
            os_unfair_lock_lock(&lastLoudTimeLock)
            lastLoudTime = DispatchTime.now().uptimeNanoseconds
            os_unfair_lock_unlock(&lastLoudTimeLock)
        }

        // Check for silence after ~3 seconds of data
        if !silenceChecked && Double(totalFrames) > kSystemAudioSampleRate * 3 {
            silenceChecked = true
            if peakLevel < 1e-6 {
                silenceWarned = true
                if micCapture != nil {
                    fputs("[SILENCE_WARNING] System audio is silent (mic is still recording). No system audio sources detected.\n", stderr)
                } else {
                    fputs("[SILENCE_WARNING] Audio data received but peak level is near zero (\(peakLevel)). Audio may be silent.\n", stderr)
                    fputs("Check: System Settings > Privacy & Security > Screen Recording — enable your terminal app.\n", stderr)
                }
            }
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("Stream error: \(error)\n", stderr)
    }

    // MARK: - Stop

    func stop() {
        silenceTimer?.cancel()
        silenceTimer = nil

        if powerAssertionID != IOPMAssertionID(kIOPMNullAssertionID) {
            IOPMAssertionRelease(powerAssertionID)
            powerAssertionID = IOPMAssertionID(kIOPMNullAssertionID)
        }

        let sem = DispatchSemaphore(value: 0)
        Task.detached { [stream] in
            try? await stream?.stopCapture()
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 2)

        // AVAudioFile finalizes on close
        audioFile = nil

        let seconds = Double(totalFrames) / kSystemAudioSampleRate
        fputs("Saved \(outputPath) (\(String(format: "%.1f", seconds)) seconds, peak=\(String(format: "%.6f", peakLevel)))\n", stderr)
        if totalFrames > 0 && peakLevel < 1e-6 {
            fputs("[SILENCE_WARNING] Recording appears silent. Check Screen Recording permission.\n", stderr)
        }
    }

    enum CaptureError: Error, CustomStringConvertible {
        case cannotOpenFile(String)
        case noDisplay

        var description: String {
            switch self {
            case .cannotOpenFile(let p): return "Cannot open file: \(p)"
            case .noDisplay: return "No display found"
            }
        }
    }
}

// MARK: - List apps

func listAudioApps() {
    print("Running apps:")
    for app in NSWorkspace.shared.runningApplications {
        if app.activationPolicy == .regular, let name = app.localizedName {
            print("  PID \(app.processIdentifier): \(name)")
        }
    }
}

// MARK: - List input devices

func listInputDevices() {
    // Get default input device
    var defaultAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var defaultDevice: AudioDeviceID = 0
    var defaultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                &defaultAddr, 0, nil, &defaultSize, &defaultDevice)

    // Enumerate all devices
    var propAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    var dataSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                    &propAddress, 0, nil, &dataSize)
    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                &propAddress, 0, nil, &dataSize, &devices)

    print("Input devices:")
    for deviceID in devices {
        // Get device name
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfNameRef: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &nameSize, &cfNameRef)
        let name = cfNameRef?.takeRetainedValue() as String? ?? "(unknown)"

        // Check input channel count
        var inputAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var bufSize: UInt32 = 0
        AudioObjectGetPropertyDataSize(deviceID, &inputAddr, 0, nil, &bufSize)
        guard bufSize > 0 else { continue }

        let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferList.deallocate() }
        AudioObjectGetPropertyData(deviceID, &inputAddr, 0, nil, &bufSize, bufferList)
        let inputChannels = UnsafeMutableAudioBufferListPointer(bufferList)
            .reduce(0) { $0 + Int($1.mNumberChannels) }

        if inputChannels > 0 {
            let suffix = (deviceID == defaultDevice) ? " (default)" : ""
            print("  \(name)\(suffix)")
        }
    }
}

// MARK: - Merge audio files with timestamp alignment

func mergeAudioFiles(systemPath: String, micPath: String,
                     systemStartHostTime: UInt64, micStartHostTime: UInt64,
                     outputPath: String, micGate: Bool = true, keepTracks: Bool = false) throws {
    // A standard WAV file header (RIFF + fmt + data chunk header) is 44 bytes.
    // Files at or below this size contain no audio frames.
    let wavHeaderSize = 44
    let fm = FileManager.default
    let systemFileSize = (try? fm.attributesOfItem(atPath: systemPath)[.size] as? Int) ?? 0
    let micFileSize = (try? fm.attributesOfItem(atPath: micPath)[.size] as? Int) ?? 0

    // Both empty — clean up temp files and let the caller handle it
    if systemFileSize <= wavHeaderSize && micFileSize <= wavHeaderSize {
        try? fm.removeItem(atPath: systemPath)
        try? fm.removeItem(atPath: micPath)
        return
    }

    // Mic empty but system has data — just rename system file
    if micFileSize <= wavHeaderSize && systemFileSize > wavHeaderSize {
        try? fm.removeItem(atPath: micPath)
        try fm.moveItem(atPath: systemPath, toPath: outputPath)
        fputs("Merged audio saved to \(outputPath) (system only, no mic audio)\n", stderr)
        return
    }

    // Open files — system is optional (may be empty when only mic captured audio)
    let systemFile: AVAudioFile? = systemFileSize > wavHeaderSize
        ? try AVAudioFile(forReading: URL(fileURLWithPath: systemPath)) : nil
    let micFile = try AVAudioFile(forReading: URL(fileURLWithPath: micPath))

    let outputSampleRate: Double = kSystemAudioSampleRate
    let outputChannels: AVAudioChannelCount = 1

    // Compute offset in seconds between the two start times using mach_timebase_info
    let offsetFrames: Int64
    if systemFile != nil {
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        let ticksToNanos = Double(timebase.numer) / Double(timebase.denom)
        let systemStartNanos = Double(systemStartHostTime) * ticksToNanos
        let micStartNanos = Double(micStartHostTime) * ticksToNanos
        let offsetSeconds = (micStartNanos - systemStartNanos) / 1_000_000_000.0
        offsetFrames = Int64(offsetSeconds * outputSampleRate)
    } else {
        offsetFrames = 0
    }
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: outputSampleRate,
                                      channels: outputChannels,
                                      interleaved: true)!
    let outputFile = try AVAudioFile(forWriting: URL(fileURLWithPath: outputPath),
                                      settings: outputFormat.settings,
                                      commonFormat: .pcmFormatFloat32,
                                      interleaved: true)

    // Mic converter using callback API (handles sample rate + channel conversion)
    let micFormat = micFile.processingFormat
    let micConverter = AVAudioConverter(from: micFormat, to: outputFormat)!
    let micRate = micFormat.sampleRate

    let chunkSize: AVAudioFrameCount = 8192
    let systemLength = systemFile.map { Int64($0.length) } ?? 0
    // Mic file length converted to output-rate frames
    let micLengthOutput = Int64(Double(micFile.length) * outputSampleRate / micRate)

    // Calculate total output length accounting for offset
    let systemEndFrame = (offsetFrames >= 0) ? systemLength : systemLength + (-offsetFrames)
    let micEndFrame = (offsetFrames >= 0) ? micLengthOutput + offsetFrames : micLengthOutput
    let totalOutputFrames = max(systemEndFrame, micEndFrame)

    // Mic region in output timeline
    let micOutputStart: Int64 = (offsetFrames >= 0) ? offsetFrames : 0
    let micOutputEnd: Int64 = micOutputStart + micLengthOutput
    var micDone = false

    // Mic gate (LOCAL PATCH 5): mute the mic while the system track is loud. Indexed by system-file
    // frame; micGain is one-pole smoothed (~8 ms) so the gate doesn't click.
    let gateMap: [Bool] = (micGate && systemFile != nil) ? try micGateMap(systemFile!) : []
    var micGain: Float = 1
    // --keep-tracks: also write the two tracks aligned on the output timeline (24 kHz mono, mic
    // ungated) as <output>.sys.wav / <output>.mic.wav for an offline echo canceller downstream.
    let trackFiles: (sys: AVAudioFile, mic: AVAudioFile)? = keepTracks ? (
        try AVAudioFile(forWriting: URL(fileURLWithPath: outputPath + ".sys.wav"), settings: outputFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: true),
        try AVAudioFile(forWriting: URL(fileURLWithPath: outputPath + ".mic.wav"), settings: outputFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: true)) : nil
    if !gateMap.isEmpty {
        let pct = 100 * gateMap.filter { $0 }.count / max(1, gateMap.count)
        fputs("Mic gate: system audio loud in \(pct)% of the recording — mic muted there\n", stderr)
    }

    var outputFrame: Int64 = 0

    while outputFrame < totalOutputFrames {
        let framesToProcess = AVAudioFrameCount(min(Int64(chunkSize), totalOutputFrames - outputFrame))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: framesToProcess) else { break }
        outBuffer.frameLength = framesToProcess

        // Zero the output buffer
        let outPtr = outBuffer.floatChannelData![0]
        for i in 0..<Int(framesToProcess * outputChannels) {
            outPtr[i] = 0
        }
        var trackBufs: (sys: AVAudioPCMBuffer, mic: AVAudioPCMBuffer)? = nil
        if trackFiles != nil, let sb = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: framesToProcess),
           let mb = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: framesToProcess) {
            sb.frameLength = framesToProcess; mb.frameLength = framesToProcess
            memset(sb.floatChannelData![0], 0, Int(framesToProcess) * 4); memset(mb.floatChannelData![0], 0, Int(framesToProcess) * 4)
            trackBufs = (sb, mb)
        }

        // Read and mix system audio (manual interleave from non-interleaved processingFormat)
        if let systemFile = systemFile {
            let sysFrameInFile = (offsetFrames >= 0) ? outputFrame : outputFrame + offsetFrames
            let writeOffset = max(0, -sysFrameInFile)
            let readStart = max(0, sysFrameInFile)
            if readStart < systemLength && writeOffset < Int64(framesToProcess) {
                let maxRead = Int64(framesToProcess) - writeOffset
                let sysReadCount = AVAudioFrameCount(min(maxRead, systemLength - readStart))
                if sysReadCount > 0 {
                    systemFile.framePosition = AVAudioFramePosition(readStart)
                    if let sysBuf = AVAudioPCMBuffer(pcmFormat: systemFile.processingFormat, frameCapacity: sysReadCount) {
                        try systemFile.read(into: sysBuf, frameCount: sysReadCount)
                        let sysData = sysBuf.floatChannelData!
                        let sysCh = Int(sysBuf.format.channelCount)
                        let wo = Int(writeOffset)
                        for i in 0..<Int(sysBuf.frameLength) {
                            var mix: Float = 0
                            for ch in 0..<sysCh { mix += sysData[ch][i] }
                            outPtr[wo + i] += mix / Float(sysCh)
                            trackBufs?.sys.floatChannelData![0][wo + i] = mix / Float(sysCh)
                        }
                    }
                }
            }
        }

        // Read and mix mic audio using callback-based converter
        let chunkEnd = outputFrame + Int64(framesToProcess)
        if !micDone && chunkEnd > micOutputStart && outputFrame < micOutputEnd {
            let overlapStart = max(outputFrame, micOutputStart)
            let overlapEnd = min(chunkEnd, micOutputEnd)
            let micFramesNeeded = AVAudioFrameCount(overlapEnd - overlapStart)

            if micFramesNeeded > 0 {
                guard let micOutBuf = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: micFramesNeeded) else { break }

                var convError: NSError?
                let status = micConverter.convert(to: micOutBuf, error: &convError) { inNumberOfPackets, outStatus in
                    let remaining = AVAudioFrameCount(micFile.length - micFile.framePosition)
                    if remaining == 0 {
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    let toRead = min(inNumberOfPackets, remaining)
                    guard let buf = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: toRead) else {
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    do {
                        try micFile.read(into: buf, frameCount: toRead)
                        outStatus.pointee = .haveData
                        return buf
                    } catch {
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                }

                if status == .endOfStream {
                    micDone = true
                }

                // Mix converted mic audio into output at correct position
                if micOutBuf.frameLength > 0 {
                    let offsetInChunk = Int(overlapStart - outputFrame)
                    let srcPtr = micOutBuf.floatChannelData![0]
                    let count = Int(micOutBuf.frameLength * outputChannels)
                    for i in 0..<count {
                        if !gateMap.isEmpty {
                            let sysFrame = (offsetFrames >= 0) ? overlapStart + Int64(i) : overlapStart + Int64(i) + offsetFrames
                            let block = Int(sysFrame / Int64(kMicGateBlockFrames))
                            let gated = sysFrame >= 0 && block < gateMap.count && gateMap[block]
                            micGain += ((gated ? 0 : 1) - micGain) * 0.005
                        }
                        outPtr[offsetInChunk * Int(outputChannels) + i] += srcPtr[i] * micGain
                        trackBufs?.mic.floatChannelData![0][offsetInChunk + i] = srcPtr[i]
                    }
                }
            }
        }

        // Clamp to [-1, 1]
        let totalSamples = Int(framesToProcess * outputChannels)
        for i in 0..<totalSamples {
            outPtr[i] = max(-1.0, min(1.0, outPtr[i]))
        }

        try outputFile.write(from: outBuffer)
        if let t = trackFiles, let b = trackBufs { try t.sys.write(from: b.sys); try t.mic.write(from: b.mic) }
        outputFrame += Int64(framesToProcess)
    }

    // Delete temp files
    try? FileManager.default.removeItem(atPath: systemPath)
    try? FileManager.default.removeItem(atPath: micPath)

    let detail = systemFile == nil ? " (mic only, no system audio)" : ""
    fputs("Merged audio saved to \(outputPath)\(detail)\n", stderr)
}

// MARK: - Main

func printUsage() {
    fputs("""
    ownscribe-audio — system audio capture helper

    USAGE:
        ownscribe-audio capture --output FILE [--mic] [--mic-device NAME] [--silence-timeout N] [--max-duration N]
        ownscribe-audio list-apps
        ownscribe-audio list-devices
        ownscribe-audio watch-mic

    OPTIONS:
        --output, -o FILE    Output WAV file path (required for capture)
        --mic                Also capture microphone input
        --mic-device NAME    Use specific mic input device (implies --mic)
        --no-mic-gate        Keep the mic audible while system audio plays (default: muted there, kills speaker echo)
        --keep-tracks        Also write FILE.sys.wav + FILE.mic.wav (aligned, 24 kHz mono, mic ungated)
        --capture-mode-all   Capture all system audio without showing the source picker
        --silence-timeout N  Auto-stop after N seconds of silence (0 = disabled)
        --max-duration N     Auto-stop after N seconds total (0 = disabled)
        --help, -h           Show this help

    SUBCOMMANDS:
        capture              Record audio to a WAV file
        list-apps            Show running applications
        list-devices         Show available audio input devices
        request-mic          Trigger the microphone permission prompt, then exit
        watch-mic            Emit `mic on <bundleids>` / `mic off` as the mic goes live (permission-free)

    """, stderr)
}

// MARK: - Self-disclaim (LOCAL PATCH vs upstream — see capture/README.md)
//
// macOS attributes a child process's microphone request to its "responsible" app. A capture
// launched from the SwiftBar menubar resolves (verified via `launchctl procinfo`) to SwiftBar.app,
// which has no NSMicrophoneUsageDescription and no mic grant — so the request is silently denied
// and the mic records SILENCE. `responsibility_spawnattrs_setdisclaim` (an undocumented but stable
// posix_spawn SPI; LLDB and Qt rely on it) makes a spawned process its OWN responsible process, so
// the mic request is judged against THIS binary — which carries the usage string (Info.plist) — and
// can therefore prompt and hold its own grant regardless of launcher.
//
// The launcher can't set the attribute (Bun.spawn doesn't expose it), so the binary re-execs ITSELF
// once, disclaimed; the original process stays as a thin supervisor that forwards the recorder's
// stop signals (SIGINT/SIGTERM) and the mute toggle (SIGUSR1) to the disclaimed child — preserving
// the recorder's pid-tracking and SIGINT-merge-on-stop. Only the mic-touching subcommands need it.

private let kDisclaimEnvVar = "OWNSCRIBE_DISCLAIMED"
private var gDisclaimedChildPid: pid_t = 0

/// Re-exec this process disclaimed (its own TCC responsible process), then supervise it.
/// Never returns — the supervisor exits with the child's status.
private func reExecDisclaimed() -> Never {
    var exeBuf = [CChar](repeating: 0, count: 4096)
    var size = UInt32(exeBuf.count)
    let exe = _NSGetExecutablePath(&exeBuf, &size) == 0 ? String(cString: exeBuf) : CommandLine.arguments[0]

    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var envStrings = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
    envStrings.append("\(kDisclaimEnvVar)=1")
    var envp: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) }
    envp.append(nil)

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    if let handle = dlopen(nil, RTLD_LAZY), let sym = dlsym(handle, "responsibility_spawnattrs_setdisclaim") {
        typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        _ = unsafeBitCast(sym, to: DisclaimFn.self)(&attr, 1)
    } else {
        fputs("warning: responsibility_spawnattrs_setdisclaim unavailable — mic prompt may be misattributed\n", stderr)
    }

    var pid: pid_t = 0
    let rc = posix_spawn(&pid, exe, nil, &attr, argv, envp)
    posix_spawnattr_destroy(&attr)
    if rc != 0 {
        fputs("error: could not re-spawn disclaimed (\(rc)) — recording mic may be silent\n", stderr)
        exit(1)
    }
    gDisclaimedChildPid = pid
    // Forward stop/mute signals to the disclaimed child (non-capturing closure → C handler).
    let forward: @convention(c) (Int32) -> Void = { s in if gDisclaimedChildPid > 0 { kill(gDisclaimedChildPid, s) } }
    for sig in [SIGINT, SIGTERM, SIGUSR1] { signal(sig, forward) }

    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}

// MARK: - Watch mic (LOCAL PATCH vs upstream — see capture/README.md)
//
// Permission-free meeting detection for the murmur daemon. Observes
// `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device — true whenever ANY
// process opens the mic — and, on a rising edge, attributes the owner(s) via the macOS 14.4+
// process-object API (`kAudioHardwarePropertyProcessObjectList` + `kAudioProcessPropertyIsRunningInput`
// + `kAudioProcessPropertyBundleID`). Prints `mic on <bundleid,bundleid,…>` / `mic off` to stdout
// (line-buffered). It only READS run-state — it never creates a process tap — so it needs NO
// Microphone/audio-capture TCC grant and lights no mic indicator; hence `watch-mic` is deliberately
// NOT in the self-disclaim list. Consumed by src/meetwatch.ts. There is deliberately NO listener on
// `kAudioProcessPropertyIsRunningInput` (those callbacks are unreliable on macOS): the device-level
// running-state edge is the wake-up, and the process list is read synchronously on that edge.

/// The system's current default input device, or kAudioObjectUnknown if none.
private func currentDefaultInputDevice() -> AudioDeviceID {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var dev = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
    return err == noErr ? dev : AudioDeviceID(kAudioObjectUnknown)
}

/// Whether `device` currently has input IO running anywhere on the system (any process).
private func deviceIsRunningSomewhere(_ device: AudioDeviceID) -> Bool {
    guard device != AudioObjectID(kAudioObjectUnknown) else { return false }
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let err = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &running)
    return err == noErr && running != 0
}

/// Bundle ids of the processes that currently hold mic INPUT, via the macOS 14.4+ process-object
/// API. Reads only (no tap) → permission-free. Returns [] if the API is unavailable (older macOS)
/// or nothing qualifies, so the daemon fails closed (no nudge) rather than guessing.
private func micOwnerBundleIDs() -> [String] {
    var listAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &listAddr, 0, nil, &dataSize) == noErr,
          dataSize > 0 else { return [] }
    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var procs = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &listAddr, 0, nil, &dataSize, &procs) == noErr else { return [] }

    var owners = Set<String>()
    for proc in procs where proc != AudioObjectID(kAudioObjectUnknown) {
        // Does this process have active input IO right now?
        var inAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningInput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0
        var rsize = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(proc, &inAddr, 0, nil, &rsize, &running) == noErr, running != 0 else { continue }
        // Read its bundle id (mirrors the CFString read in listInputDevices()).
        var bidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyBundleID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var bidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var cfRef: Unmanaged<CFString>?
        guard AudioObjectGetPropertyData(proc, &bidAddr, 0, nil, &bidSize, &cfRef) == noErr,
              let bundle = cfRef?.takeRetainedValue() as String?, !bundle.isEmpty else { continue }
        owners.insert(bundle)
    }
    return owners.sorted()
}

/// Long-lived watcher: emit a line on every mic on/off transition until SIGINT/SIGTERM.
func watchMic() {
    setvbuf(stdout, nil, _IOLBF, 0) // line-buffered so the daemon reads edges promptly across the pipe

    let queue = DispatchQueue(label: "murmur.watch-mic") // serialize all state + emits (no data races)
    var lastOn = false
    var currentDevice = currentDefaultInputDevice()

    var runningAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    func emit() {
        let on = deviceIsRunningSomewhere(currentDevice)
        if on == lastOn { return }
        lastOn = on
        if on {
            var owners = micOwnerBundleIDs()
            if owners.isEmpty { owners = micOwnerBundleIDs() } // momentary race: process may not be listed yet
            print("mic on \(owners.joined(separator: ","))")
        } else {
            print("mic off")
        }
        fflush(stdout)
    }

    // Running-state listener, retargetable when the default input device changes (hot-swap).
    let runningBlock: AudioObjectPropertyListenerBlock = { _, _ in emit() }
    func addRunningListener(_ dev: AudioDeviceID) {
        guard dev != AudioObjectID(kAudioObjectUnknown) else { return }
        AudioObjectAddPropertyListenerBlock(dev, &runningAddr, queue, runningBlock)
    }
    func removeRunningListener(_ dev: AudioDeviceID) {
        guard dev != AudioObjectID(kAudioObjectUnknown) else { return }
        AudioObjectRemovePropertyListenerBlock(dev, &runningAddr, queue, runningBlock)
    }
    addRunningListener(currentDevice)

    var defAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defAddr, queue) { _, _ in
        let newDev = currentDefaultInputDevice()
        guard newDev != currentDevice else { return }
        removeRunningListener(currentDevice)
        currentDevice = newDev
        addRunningListener(currentDevice)
        emit() // run-state may differ on the new device
    }

    // Clean exit on stop signals (the daemon SIGTERMs us on shutdown). Sources are retained on the
    // never-returning stack frame of watchMic() (CFRunLoopRun blocks).
    var signalSources: [DispatchSourceSignal] = []
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: queue)
        src.setEventHandler { exit(0) }
        src.resume()
        signalSources.append(src)
    }

    queue.async { emit() } // emit initial state — the mic may already be live when we start
    withExtendedLifetime(signalSources) { CFRunLoopRun() }
}

func main() {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        printUsage()
        exit(1)
    }

    let command = args[1]

    // [LOCAL PATCH] The mic-touching subcommands must own their TCC attribution: re-exec disclaimed
    // once so the microphone request is judged against this binary, not the launcher (e.g. SwiftBar).
    if (command == "capture" || command == "request-mic"),
       ProcessInfo.processInfo.environment[kDisclaimEnvVar] == nil {
        reExecDisclaimed()
    }

    switch command {
    case "list-apps":
        listAudioApps()

    case "list-devices":
        listInputDevices()

    case "watch-mic":
        // [LOCAL PATCH vs upstream — see capture/README.md] Permission-free meeting detection: emit
        // `mic on <bundleids>` / `mic off` as the mic goes live. Reads only (no tap), so unlike
        // `capture`/`request-mic` it needs no self-disclaim and no TCC grant.
        watchMic()

    case "capture":
        // Initialize NSApplication so the picker GUI can render
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        var outputPath: String?
        var enableMic = false
        var micDeviceName: String?
        var micGate = true
        var keepTracks = false
        var captureModeAll = false
        var silenceTimeout: TimeInterval = 0
        var maxDuration: TimeInterval = 0

        var i = 2
        while i < args.count {
            switch args[i] {
            case "--output", "-o":
                i += 1
                guard i < args.count else {
                    fputs("Error: --output requires a file path\n", stderr)
                    exit(1)
                }
                outputPath = args[i]
            case "--capture-mode-all":
                captureModeAll = true
            case "--no-mic-gate":
                micGate = false
            case "--keep-tracks":
                keepTracks = true
            case "--mic":
                enableMic = true
            case "--mic-device":
                i += 1
                guard i < args.count else {
                    fputs("Error: --mic-device requires a device name\n", stderr)
                    exit(1)
                }
                micDeviceName = args[i]
                enableMic = true  // --mic-device implies --mic
            case "--silence-timeout":
                i += 1
                guard i < args.count, let val = TimeInterval(args[i]) else {
                    fputs("Error: --silence-timeout requires a number of seconds\n", stderr)
                    exit(1)
                }
                if val < 0 {
                    fputs("Error: --silence-timeout must be zero (disabled) or a positive number of seconds\n", stderr)
                    exit(1)
                }
                silenceTimeout = val
            case "--max-duration":
                i += 1
                guard i < args.count, let val = TimeInterval(args[i]) else {
                    fputs("Error: --max-duration requires a number of seconds\n", stderr)
                    exit(1)
                }
                if val < 0 {
                    fputs("Error: --max-duration must be zero (disabled) or a positive number of seconds\n", stderr)
                    exit(1)
                }
                maxDuration = val
            default:
                fputs("Unknown option: \(args[i])\n", stderr)
                printUsage()
                exit(1)
            }
            i += 1
        }

        guard let output = outputPath else {
            fputs("Error: --output is required\n", stderr)
            printUsage()
            exit(1)
        }

        // Determine paths: if mic enabled, use temp files then merge
        let systemPath = enableMic ? output + ".sys.tmp.wav" : output
        let micPath = output + ".mic.tmp.wav"

        let capture = SystemAudioCapture(outputPath: systemPath)
        capture.captureModeAll = captureModeAll
        capture.silenceTimeout = silenceTimeout
        var micCapture: MicCapture?

        if enableMic {
            let mic = MicCapture()
            do {
                try mic.start(outputPath: micPath, deviceName: micDeviceName)
            } catch {
                fputs("Error starting mic capture: \(error)\n", stderr)
                exit(1)
            }
            micCapture = mic
            capture.micCapture = mic
        }

        // Shared shutdown logic for SIGINT, SIGTERM, and silence timeout
        let shutdown: () -> Void = {
            capture.stop()
            if let mic = micCapture {
                mic.stop()
                do {
                    try mergeAudioFiles(
                        systemPath: systemPath,
                        micPath: micPath,
                        systemStartHostTime: capture.startHostTime,
                        micStartHostTime: mic.startHostTime,
                        outputPath: output, micGate: micGate, keepTracks: keepTracks)
                } catch {
                    fputs("Error merging audio: \(error)\n", stderr)
                }
            }
            exit(0)
        }

        capture.onSilenceTimeout = shutdown

        // Toggle mic mute on SIGUSR1 (sent by Python wrapper)
        var _sigusr1Source: DispatchSourceSignal?  // retained to keep source alive
        if let mic = micCapture {
            signal(SIGUSR1, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
            src.setEventHandler { mic.toggleMute() }
            src.resume()
            _sigusr1Source = src
        }
        _ = _sigusr1Source

        // Handle Ctrl+C gracefully
        let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        signal(SIGINT, SIG_IGN)
        sigintSource.setEventHandler { shutdown() }
        sigintSource.resume()

        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        signal(SIGTERM, SIG_IGN)
        sigtermSource.setEventHandler { shutdown() }
        sigtermSource.resume()

        // Hard duration cap — self-terminate (merge + exit) so a forgotten capture can't
        // record forever, with no dependency on an external supervisor (parity with the
        // ffmpeg backend's -t). [LOCAL PATCH vs upstream — see capture/README.md]
        if maxDuration > 0 {
            fputs("Max duration \(Int(maxDuration))s — will stop automatically.\n", stderr)
            DispatchQueue.main.asyncAfter(deadline: .now() + maxDuration) {
                fputs("[MAX_DURATION]\n", stderr)
                shutdown()
            }
        }

        Task {
            do {
                try await capture.start()
            } catch {
                fputs("Error: \(error)\n", stderr)
                exit(1)
            }
        }

        app.run()

    case "request-mic":
        // [LOCAL PATCH vs upstream — see capture/README.md] Present the microphone TCC prompt,
        // then exit. macOS only DISPLAYS a mic prompt to a process that has a window-server
        // connection and a running run loop — a bare CLI with only a semaphore never surfaces
        // the dialog (it returns without asking). So we spin up NSApplication and request on the
        // main run loop, mirroring `capture`. The long-lived `capture` process is detached by
        // murmur (proc.unref()), which swallows the prompt; running this small command
        // synchronously in the launcher's own (non-detached) process lets macOS attribute the
        // prompt to that app, so it can be authorized once. Requires the embedded
        // NSMicrophoneUsageDescription (see build.sh / Info.plist).
        let micApp = NSApplication.shared
        micApp.setActivationPolicy(.accessory)
        func micPermName(_ p: AVAudioApplication.recordPermission) -> String {
            switch p {
            case .granted: return "granted"
            case .denied: return "denied"
            case .undetermined: return "undetermined"
            @unknown default: return "unknown"
            }
        }
        DispatchQueue.main.async {
            micApp.activate(ignoringOtherApps: true)
            let before = AVAudioApplication.shared.recordPermission
            fputs("Microphone permission before request: \(micPermName(before))\n", stderr)
            AVAudioApplication.requestRecordPermission { granted in
                fputs("Microphone permission: \(granted ? "granted" : "denied")\n", stderr)
                exit(granted ? 0 : 3)
            }
        }
        micApp.run()

    case "--help", "-h":
        printUsage()

    default:
        fputs("Unknown command: \(command)\n", stderr)
        printUsage()
        exit(1)
    }
}

main()
