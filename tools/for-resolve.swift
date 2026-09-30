// Re-encode a browser recording into something DaVinci Resolve will accept.
//
// A recording straight out of MediaRecorder, inspected box by box, is:
//   - fragmented: ftyp, an empty moov, then moof/mdat repeating. The sample
//     table in moov has zero entries, so nothing that reads moov alone finds
//     any frames, and the header claims about a second for a seven-second clip
//   - variable frame rate, every frame carrying its own duration
//   - a non-standard nominal rate (29.02fps, not 24/25/30/50/60)
//   - video only, with no audio track
//
// Remuxing cannot fix frame timing, so this decodes and re-encodes, giving
// every output frame an exact presentation time of i/fps and holding source
// frames to land on that grid. A silent track is added because some Resolve
// builds refuse a video-only file.
//
// The output is ProRes 422 in a QuickTime .mov, not H.264 in .mp4. Resolve
// decodes ProRes natively on every build and platform, with none of the
// codec-licensing gaps that make an H.264 mp4 import on one machine and fail
// on the next. It costs disk space -- a few hundred MB for a short clip --
// which is the right trade for a file that opens every time. Pass `h264` as
// the fourth argument for the small version instead.
//
// Every dictionary below carries an explicit type. Without them Swift's type
// checker takes minutes on these literals instead of milliseconds.
//
// AVFoundation only - ships with macOS, nothing to install.

import AVFoundation
import Foundation

let args = CommandLine.arguments
if args.count < 3 {
    print("usage: for-resolve <in> <out> [fps]")
    exit(2)
}
let inURL: URL = URL(fileURLWithPath: args[1])
let outURL: URL = URL(fileURLWithPath: args[2])
let fps: Int32 = args.count > 3 ? (Int32(args[3]) ?? 60) : 60
let codecArg: String = args.count > 4 ? args[4].lowercased() : "prores"
let useProRes: Bool = codecArg != "h264"
try? FileManager.default.removeItem(at: outURL)

let asset: AVURLAsset = AVURLAsset(url: inURL)
var vTrack: AVAssetTrack? = nil
var srcSize: CGSize = CGSize.zero
var srcDur: CMTime = CMTime.zero
let load: DispatchSemaphore = DispatchSemaphore(value: 0)
Task {
    vTrack = try? await asset.loadTracks(withMediaType: AVMediaType.video).first
    if let t = vTrack {
        srcSize = (try? await t.load(.naturalSize)) ?? CGSize.zero
    }
    srcDur = (try? await asset.load(.duration)) ?? CMTime.zero
    load.signal()
}
load.wait()

guard let track = vTrack, srcSize.width > 0 else {
    print("  error: no readable video track")
    exit(1)
}
let W: Int = Int(srcSize.width.rounded())
let H: Int = Int(srcSize.height.rounded())

let pixFmt: Int = useProRes
    ? Int(kCVPixelFormatType_422YpCbCr8)                       // '2vuy', ProRes is 4:2:2
    : Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
let readerOutSettings: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: pixFmt
]
let compression: [String: Any] = [
    AVVideoAverageBitRateKey: Int(12_000_000),
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
    AVVideoAllowFrameReorderingKey: false
]
let colorProps: [String: Any] = [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
]
// ProRes carries no bitrate setting: it is constant-quality, so the
// compression dictionary is H.264's alone.
var videoSettings: [String: Any] = [
    AVVideoCodecKey: useProRes ? AVVideoCodecType.proRes422 : AVVideoCodecType.h264,
    AVVideoWidthKey: W,
    AVVideoHeightKey: H,
    AVVideoColorPropertiesKey: colorProps
]
if !useProRes { videoSettings[AVVideoCompressionPropertiesKey] = compression }
let bufferAttrs: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: pixFmt,
    kCVPixelBufferWidthKey as String: W,
    kCVPixelBufferHeightKey as String: H
]
let audioSettings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: Double(44100),
    AVNumberOfChannelsKey: Int(1),
    AVEncoderBitRateKey: Int(64000)
]

do {
    let reader: AVAssetReader = try AVAssetReader(asset: asset)
    let rOut: AVAssetReaderTrackOutput = AVAssetReaderTrackOutput(track: track, outputSettings: readerOutSettings)
    // We hold a frame across iterations to fill the timing grid, so the
    // decoder must not recycle it underneath us.
    rOut.alwaysCopiesSampleData = true
    reader.add(rOut)

    let writer: AVAssetWriter = try AVAssetWriter(outputURL: outURL,
        fileType: useProRes ? AVFileType.mov : AVFileType.mp4)
    // Only meaningful for the streaming case; ProRes files are edited locally.
    writer.shouldOptimizeForNetworkUse = !useProRes

    let vIn: AVAssetWriterInput = AVAssetWriterInput(mediaType: AVMediaType.video, outputSettings: videoSettings)
    vIn.expectsMediaDataInRealTime = false
    let adaptor: AVAssetWriterInputPixelBufferAdaptor =
        AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: bufferAttrs)
    writer.add(vIn)

    let aIn: AVAssetWriterInput = AVAssetWriterInput(mediaType: AVMediaType.audio, outputSettings: audioSettings)
    aIn.expectsMediaDataInRealTime = false
    writer.add(aIn)

    if !writer.startWriting() {
        print("  error: cannot start writing")
        exit(1)
    }
    writer.startSession(atSourceTime: CMTime.zero)
    reader.startReading()

    let frameDur: CMTime = CMTime(value: 1, timescale: fps)
    let totalOut: Int = max(1, Int((CMTimeGetSeconds(srcDur) * Double(fps)).rounded()))
    let rate: Double = 44100
    let chunk: Int = 1024
    let totalSamples: Int = Int(Double(totalOut) / Double(fps) * rate)

    var asbd: AudioStreamBasicDescription = AudioStreamBasicDescription(
        mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
        mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var fmt: CMAudioFormatDescription? = nil
    CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
        extensions: nil, formatDescriptionOut: &fmt)

    func pushAudio(upTo seconds: Double, made: inout Int) -> Bool {
        guard let fd = fmt else { return true }
        while made < totalSamples && Double(made) / rate < seconds {
            if !aIn.isReadyForMoreMediaData { return false }
            let n: Int = min(chunk, totalSamples - made)
            let bytes: Int = n * 2
            var block: CMBlockBuffer? = nil
            CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
                blockLength: bytes, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
                offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag,
                blockBufferOut: &block)
            guard let bb = block else { return true }
            CMBlockBufferFillDataBytes(with: 0, blockBuffer: bb, offsetIntoDestination: 0, dataLength: bytes)
            var timing: CMSampleTimingInfo = CMSampleTimingInfo(
                duration: CMTime(value: 1, timescale: Int32(rate)),
                presentationTimeStamp: CMTime(value: CMTimeValue(made), timescale: Int32(rate)),
                decodeTimeStamp: CMTime.invalid)
            var sb: CMSampleBuffer? = nil
            let sizes: [Int] = [2]
            CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: bb,
                formatDescription: fd, sampleCount: n, sampleTimingEntryCount: 1,
                sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: sizes,
                sampleBufferOut: &sb)
            guard let s = sb else { return true }
            if !aIn.append(s) { return true }
            made += n
        }
        return true
    }

    var pending: CMSampleBuffer? = rOut.copyNextSampleBuffer()
    var current: CVPixelBuffer? = nil
    var currentSB: CMSampleBuffer? = nil   // keeps `current` alive
    var currentEnd: CMTime = CMTime.zero
    var written: Int = 0
    var held: Int = 0
    var exhausted: Bool = false
    var audioMade: Int = 0
    var videoDone: Bool = false
    var audioFinished: Bool = false
    var idle: Int = 0
    var stopReason: String = ""

    // Both inputs must be fed together. Writing every video frame first and
    // the audio afterwards stalls the writer: it interleaves tracks, so a
    // starved audio input stops the video input ever reporting ready again.
    // The audio input is closed the moment it has all its samples rather than
    // after the loop. The writer interleaves, and while an input is still open
    // it can hold the other one waiting for more: with audio complete but not
    // marked finished, the video input stopped reporting ready and the last
    // half second -- the end card with the address on it -- never got written.
    while !videoDone || !audioFinished {
        var moved: Bool = false

        // Once the writer or the reader gives up, neither input will ever
        // report ready again, `moved` stays false, and the loop below spins
        // on usleep forever. A truncated recording in the folder did exactly
        // that and hung a whole batch rather than failing and moving on.
        if writer.status != AVAssetWriter.Status.writing {
            stopReason = "writer stopped: \(writer.error?.localizedDescription ?? "unknown")"
            break
        }
        if reader.status == AVAssetReader.Status.failed && current == nil {
            stopReason = "cannot decode the source: \(reader.error?.localizedDescription ?? "unknown")"
            break
        }

        if !videoDone && vIn.isReadyForMoreMediaData {
            if written >= totalOut {
                videoDone = true
            } else {
                let t: CMTime = CMTimeMultiply(frameDur, multiplier: Int32(written))
                while !exhausted && (current == nil || CMTimeCompare(currentEnd, t) <= 0) {
                    guard let sb = pending else { exhausted = true; break }
                    if let px = CMSampleBufferGetImageBuffer(sb) {
                        current = px
                        currentSB = sb
                        let pts: CMTime = CMSampleBufferGetPresentationTimeStamp(sb)
                        var d: CMTime = CMSampleBufferGetDuration(sb)
                        if !d.isValid || d.value == 0 { d = frameDur }
                        currentEnd = CMTimeAdd(pts, d)
                    }
                    pending = rOut.copyNextSampleBuffer()
                }
                if let px = current, adaptor.append(px, withPresentationTime: t) {
                    if CMTimeCompare(currentEnd, CMTimeAdd(t, frameDur)) > 0 { held += 1 }
                    written += 1
                    moved = true
                    // When the source runs out early, hold its last frame rather
                    // than stopping: the clip must run for its full length.
                } else {
                    if current == nil { stopReason = "no frame available" }
                    else { stopReason = "append refused at frame \(written)" }
                    videoDone = true
                }
            }
            if videoDone { vIn.markAsFinished() }
        }

        // keep audio half a second ahead of the video so neither input starves
        let ahead: Double = idle > 200
            ? Double(totalSamples) / rate
            : Double(written) / Double(fps) + 0.5
        let before: Int = audioMade
        _ = pushAudio(upTo: videoDone ? Double(totalSamples) / rate : ahead, made: &audioMade)
        if audioMade != before { moved = true }
        if audioMade >= totalSamples && !audioFinished {
            aIn.markAsFinished(); audioFinished = true; moved = true
        }

        if !moved {
            idle += 1
            // Generous on purpose. This has to be longer than the longest
            // legitimate pause, and writing a gigabyte of ProRes under a
            // throttled I/O priority pauses for a good while: at ten seconds
            // a background job gave up two thirds of the way through a clip
            // that converts fine in the foreground.
            if idle > 30000 { stopReason = "stalled with \(written) of \(totalOut) frames written"; break }
            usleep(2000)
        } else { idle = 0 }
    }
    if !videoDone { vIn.markAsFinished() }
    if !audioFinished { aIn.markAsFinished() }
    _ = currentSB      // held only to keep the last pixel buffer alive above

    let done: DispatchSemaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()

    if writer.status != AVAssetWriter.Status.completed {
        print("  error: write failed\(stopReason.isEmpty ? "" : " -- " + stopReason)")
        exit(1)
    }
    // An empty or near-empty result means the source was unusable; saying so
    // beats leaving a file behind that fails later, inside Resolve.
    if written < 2 {
        print("  error: no usable frames in the source\(stopReason.isEmpty ? "" : " -- " + stopReason)")
        exit(1)
    }
    if written < totalOut - 2 {
        print("  error: source ended early -- \(written) of \(totalOut) frames"
            + "\(stopReason.isEmpty ? "" : " (" + stopReason + ")")")
        print("          that recording is truncated; record it again.")
        exit(1)
    }
    let secs: Double = Double(written) / Double(fps)
    let attrs = try? FileManager.default.attributesOfItem(atPath: outURL.path)
    let bytes: Int = (attrs?[.size] as? NSNumber)?.intValue ?? 0
    print("  codec   : \(useProRes ? "ProRes 422 in .mov" : "H.264 in .mp4")")
    print("  frames  : \(written) at exactly \(fps)fps (\(held) held to fill the grid)")
    print("  length  : \(String(format: "%.2f", secs))s")
    if bytes > 0 { print("  size    : \(String(format: "%.0f", Double(bytes) / 1e6)) MB") }
    if !stopReason.isEmpty { print("  note    : \(stopReason)") }
} catch {
    print("  error: \(error)")
    exit(1)
}
