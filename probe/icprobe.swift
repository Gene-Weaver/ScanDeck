// icprobe — ImageCaptureCore scanner probe for ScanDeck (Phase 0).
//
// Build:  swiftc -swift-version 5 -O -o icprobe icprobe.swift
// Usage:  ./icprobe list                     # which scanners does ImageCaptureCore see?
//         ./icprobe caps                     # open session, select flatbed, dump capabilities as JSON
//         ./icprobe scan --dpi 300 --bits 8 --area 0,0,2,2 --out ./out --name test
//                                            # SIGINT/SIGTERM during a scan → cancelScan, clean session close
//                                            # --transfer memory: live bands (PREVIEW/rows lines on stderr), TIFF via ImageIO
//                                            # --set VF_UNSHARPMASK=Medium (repeatable) turns on one Epson correction;
//                                            # all others stay off
//                                            # area = x,y,w,h in inches on the flatbed, or "full" (whole glass)
//                                            # --doc a4|letter sets the flatbed document type first
//
// Talks to the scanner only through Apple's ImageCaptureCore + the vendor ICA driver.

import Foundation
import ImageCaptureCore
import ImageIO
import CoreGraphics

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func emit(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

enum Mode { case list, caps, scan, overview }

struct ScanOpts {
    var dpi = 300
    var bits = 8
    var area = NSRect(x: 0, y: 0, width: 2, height: 2) // inches
    var out = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("out")
    var name = "icprobe_scan"
    var fullBed = false
    var doc: Int? = nil   // ICScannerDocumentType raw value (1 = A4, 3 = US Letter); nil = driver default
    var vendorSet: [String: String] = [:]   // --set VF_NAME=value: corrections to turn on (everything else is off)
    var memory = false                      // --transfer memory: bands as they are scanned (live preview), TIFF written here
    var previewWidth = 640                  // live preview rows are downsampled to at most this width
    var repeats = 0                         // --repeat N: N more scans in the same session (timing test)
}

func indexSetArray(_ s: IndexSet) -> [Int] {
    // Resolution sets can be huge contiguous ranges; summarize those.
    if s.count > 64, let lo = s.first, let hi = s.last { return [lo, -1, hi] } // [-1] marks "range"
    return Array(s)
}

func unitTypeName(_ t: ICScannerFunctionalUnitType) -> String {
    switch t {
    case .flatbed: return "flatbed"
    case .positiveTransparency: return "positiveTransparency"
    case .negativeTransparency: return "negativeTransparency"
    case .documentFeeder: return "documentFeeder"
    @unknown default: return "unknown(\(t.rawValue))"
    }
}

func featureDict(_ f: ICScannerFeature) -> [String: Any] {
    var d: [String: Any] = [
        "internalName": f.internalName ?? "",
        "humanReadableName": f.humanReadableName ?? "",
        "tooltip": f.tooltip ?? "",
        "type": f.type.rawValue,
    ]
    if let e = f as? ICScannerFeatureEnumeration {
        d["kind"] = "enumeration"
        d["values"] = e.values.map { "\($0)" }
        d["menuItemLabels"] = e.menuItemLabels
        d["current"] = "\(e.currentValue)"
        d["default"] = "\(e.defaultValue)"
    } else if let r = f as? ICScannerFeatureRange {
        d["kind"] = "range"
        d["min"] = r.minValue; d["max"] = r.maxValue; d["step"] = r.stepSize
        d["current"] = r.currentValue; d["default"] = r.defaultValue
    } else if let b = f as? ICScannerFeatureBoolean {
        d["kind"] = "boolean"; d["value"] = b.value
    } else if f is ICScannerFeatureTemplate {
        d["kind"] = "template"
    }
    return d
}

func unitDict(_ fu: ICScannerFunctionalUnit) -> [String: Any] {
    var d: [String: Any] = [
        "type": unitTypeName(fu.type),
        "pixelDataType": fu.pixelDataType.rawValue,
        "supportedBitDepths": Array(fu.supportedBitDepths),
        "bitDepth": fu.bitDepth.rawValue,
        "supportedMeasurementUnits": Array(fu.supportedMeasurementUnits),
        "measurementUnit": fu.measurementUnit.rawValue,
        "supportedResolutions": indexSetArray(fu.supportedResolutions),
        "preferredResolutions": Array(fu.preferredResolutions),
        "resolution": fu.resolution,
        "nativeXResolution": fu.nativeXResolution,
        "nativeYResolution": fu.nativeYResolution,
        "supportedScaleFactors": indexSetArray(fu.supportedScaleFactors),
        "scaleFactor": fu.scaleFactor,
        "physicalSize": ["w": fu.physicalSize.width, "h": fu.physicalSize.height],
        "scanArea": ["x": fu.scanArea.origin.x, "y": fu.scanArea.origin.y,
                     "w": fu.scanArea.size.width, "h": fu.scanArea.size.height],
        "canPerformOverviewScan": fu.canPerformOverviewScan,
        "overviewResolution": fu.overviewResolution,
        "state": fu.state.rawValue,
        "templates": fu.templates.map { $0.targets.count },
        "vendorFeatures": (fu.vendorFeatures ?? []).map(featureDict),
    ]
    if let fb = fu as? ICScannerFunctionalUnitFlatbed {
        d["supportedDocumentTypes"] = Array(fb.supportedDocumentTypes)
        d["documentType"] = fb.documentType.rawValue
        d["documentSize"] = ["w": fb.documentSize.width, "h": fb.documentSize.height]
    }
    return d
}

final class Probe: NSObject, ICDeviceBrowserDelegate, ICScannerDeviceDelegate {
    let mode: Mode
    var opts = ScanOpts()
    let browser = ICDeviceBrowser()
    var scanner: ICScannerDevice?
    var done = false
    var exitCode: Int32 = 0
    var report: [String: Any] = [:]
    var unitsToVisit: [ICScannerFunctionalUnitType] = []
    var units: [[String: Any]] = []
    var scannedFiles: [String] = []
    var t0 = Date()
    var scanning = false
    var mem: MemoryScan?

    init(mode: Mode) { self.mode = mode }

    // SIGINT/SIGTERM: ask the driver to cancel instead of dying mid-scan, which can leave the Epson
    // ICA session held until the scanner is power-cycled. The cancelled scan still ends through
    // didCompleteScanWithError, which closes the session and exits.
    func cancel() {
        report["cancelled"] = true
        if scanning, let s = scanner {
            log("cancel requested; stopping the scan…")
            s.cancelScan()
        } else {
            log("cancelled")
            scanner?.requestCloseSession()
            emit(report)
            finish(130)
        }
    }

    func start() {
        browser.delegate = self
        let mask = ICDeviceTypeMask.scanner.rawValue
            | ICDeviceLocationTypeMask.local.rawValue
            | ICDeviceLocationTypeMask.shared.rawValue
            | ICDeviceLocationTypeMask.bonjour.rawValue
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: mask)!
        log("browsing for scanners…")
        browser.start()
    }

    func finish(_ code: Int32 = 0) { exitCode = code; done = true }

    // MARK: ICDeviceBrowserDelegate
    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        let info: [String: Any] = [
            "name": device.name ?? "", "productKind": device.productKind ?? "",
            "transportType": device.transportType ?? "", "uuid": device.uuidString ?? "",
            "usbVendorID": device.usbVendorID, "usbProductID": device.usbProductID,
            "moduleVersion": device.moduleVersion ?? "", "modulePath": device.modulePath,
            "persistentID": device.persistentIDString ?? "",
            "capabilities": device.capabilities,
        ]
        log("found: \(device.name ?? "?") [\(device.transportType ?? "?")]")
        report["device"] = info
        guard let s = device as? ICScannerDevice else { return }
        if mode == .list { return }
        if scanner == nil {
            scanner = s
            s.delegate = self
            log("opening session…")
            s.requestOpenSession()
        }
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        log("removed: \(device.name ?? "?")")
    }

    func deviceBrowserDidEnumerateLocalDevices(_ browser: ICDeviceBrowser) {
        log("local enumeration complete (\(browser.devices?.count ?? 0) device(s))")
        if mode == .list || (browser.devices ?? []).isEmpty {
            report["devices"] = (browser.devices ?? []).map { ["name": $0.name ?? "", "type": $0.type.rawValue] }
            emit(report)
            finish((browser.devices ?? []).isEmpty ? 2 : 0)
        }
    }

    // MARK: ICDeviceDelegate
    func didRemove(_ device: ICDevice) { log("device removed"); finish(3) }

    func device(_ device: ICDevice, didOpenSessionWithError error: (any Error)?) {
        if let error { log("open session failed: \(error)"); report["openSessionError"] = "\(error)"; emit(report); finish(4); return }
        log("session open")
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: (any Error)?) {}

    func deviceDidBecomeReady(_ device: ICDevice) {
        guard let s = device as? ICScannerDevice else { return }
        log("device ready; functional units: \(s.availableFunctionalUnitTypes)")
        report["availableFunctionalUnitTypes"] = s.availableFunctionalUnitTypes.map { $0.intValue }
        report["transferMode"] = s.transferMode.rawValue
        report["maxMemoryBandSize"] = s.maxMemoryBandSize
        report["defaultDocumentUTI"] = s.documentUTI
        report["defaultDownloadsDirectory"] = s.downloadsDirectory.path
        if mode == .caps {
            unitsToVisit = s.availableFunctionalUnitTypes.compactMap { ICScannerFunctionalUnitType(rawValue: $0.uintValue) }
            selectNext(s)
        } else {
            select(s, .flatbed) { [weak self] fu in
                guard let self else { return }
                guard let fu else { self.report["error"] = "flatbed never became selected"; emit(self.report); self.finish(5); return }
                if self.mode == .overview { self.overview(s, fu) } else { self.configureAndScan(s, fu) }
            }
        }
    }

    // The Epson driver's didSelect callbacks lag behind requests and can deliver a unit
    // whose properties are still empty, so poll selectedFunctionalUnit until it is the
    // requested type and has a physical size.
    var pending: (type: ICScannerFunctionalUnitType, deadline: Date, then: (ICScannerFunctionalUnit?) -> Void)?

    func select(_ s: ICScannerDevice, _ t: ICScannerFunctionalUnitType, then: @escaping (ICScannerFunctionalUnit?) -> Void) {
        log("selecting \(unitTypeName(t))…")
        pending = (t, Date().addingTimeInterval(20), then)
        s.requestSelect(t)
        pollSelection(s)
    }

    func pollSelection(_ s: ICScannerDevice) {
        guard let p = pending else { return }
        let fu = s.value(forKey: "selectedFunctionalUnit") as? ICScannerFunctionalUnit
        if let fu, fu.type == p.type, fu.physicalSize.width > 0 {
            pending = nil
            log("selected \(unitTypeName(fu.type)) (\(fu.physicalSize.width)×\(fu.physicalSize.height))")
            p.then(fu)
            return
        }
        if Date() > p.deadline {
            pending = nil
            log("select \(unitTypeName(p.type)) timed out; driver reports \(fu.map { unitTypeName($0.type) } ?? "nil")")
            p.then(nil)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.pollSelection(s) }
    }

    func selectNext(_ s: ICScannerDevice) {
        if unitsToVisit.isEmpty {
            report["functionalUnits"] = units
            emit(report)
            s.requestCloseSession()
            finish(0)
            return
        }
        let t = unitsToVisit.removeFirst()
        select(s, t) { [weak self] fu in
            guard let self else { return }
            self.units.append(fu.map(unitDict) ?? ["type": unitTypeName(t), "selectTimedOut": true])
            self.selectNext(s)
        }
    }

    // MARK: ICScannerDeviceDelegate
    func scannerDeviceDidBecomeAvailable(_ scanner: ICScannerDevice) { log("scanner available") }

    func scannerDevice(_ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: (any Error)?) {
        log("didSelect callback: \(unitTypeName(functionalUnit.type))\(error.map { " error: \($0)" } ?? "")")
    }

    func configureAndScan(_ s: ICScannerDevice, _ fu: ICScannerFunctionalUnit) {
        guard fu.type == .flatbed else { log("flatbed not selected"); finish(5); return }
        fu.measurementUnit = .inches
        fu.pixelDataType = .RGB
        fu.bitDepth = opts.bits == 16 ? .depth16Bits : .depth8Bits
        fu.resolution = opts.dpi
        if let fb = fu as? ICScannerFunctionalUnitFlatbed, let d = opts.doc, let t = ICScannerDocumentType(rawValue: UInt(d)) {
            fb.documentType = t
        }
        if opts.fullBed { opts.area = NSRect(origin: .zero, size: fu.physicalSize) }
        fu.scanArea = opts.area
        let vendor = applyVendorFeatures(fu, opts.vendorSet)
        try? FileManager.default.createDirectory(at: opts.out, withIntermediateDirectories: true)
        s.transferMode = opts.memory ? .memoryBased : .fileBased
        s.documentUTI = "public.tiff"
        s.downloadsDirectory = opts.out
        s.documentName = opts.name
        // Report what the driver actually accepted, before scanning.
        report["requested"] = ["dpi": opts.dpi, "bits": opts.bits,
                               "area_in": [opts.area.origin.x, opts.area.origin.y, opts.area.width, opts.area.height]]
        report["accepted"] = ["dpi": fu.resolution, "bitDepth": fu.bitDepth.rawValue,
                              "pixelDataType": fu.pixelDataType.rawValue,
                              "scanArea": [fu.scanArea.origin.x, fu.scanArea.origin.y, fu.scanArea.width, fu.scanArea.height],
                              "documentType": (fu as? ICScannerFunctionalUnitFlatbed).map { Int($0.documentType.rawValue) } ?? -1,
                              "documentSize": (fu as? ICScannerFunctionalUnitFlatbed).map { [$0.documentSize.width, $0.documentSize.height] } ?? [CGFloat](),
                              "documentUTI": s.documentUTI,
                              "vendorFeatures": vendor]
        log("scanning… accepted=\(report["accepted"]!)")
        t0 = Date()
        scanning = true
        s.requestScan()
        pollProgress(fu)
    }

    // Unsharp mask, descreening, backlight correction, dust removal → "None"; color restoration → off,
    // unless --set names one. They default to off, but pin them so every scan is reproducible
    // regardless of driver state. An enumeration value is matched by its value or its menu label.
    func applyVendorFeatures(_ fu: ICScannerFunctionalUnit, _ set: [String: String]) -> [[String: Any]] {
        var unmatched = set
        for f in fu.vendorFeatures ?? [] {
            let want = f.internalName.flatMap { set[$0] }
            if want != nil { unmatched.removeValue(forKey: f.internalName ?? "") }
            if let e = f as? ICScannerFeatureEnumeration {
                var i = e.menuItemLabels.firstIndex { $0.lowercased() == "none" } ?? 0
                if let w = want?.lowercased() {
                    if let j = e.menuItemLabels.firstIndex(where: { $0.lowercased() == w || $0.lowercased().hasPrefix(w) })
                        ?? e.values.firstIndex(where: { "\($0)" == w }) {
                        i = j
                    } else {
                        log("\(f.internalName ?? "?"): no value \"\(w)\" (have \(e.menuItemLabels))")
                        report["vendorErrors"] = (report["vendorErrors"] as? [String] ?? []) + ["\(f.internalName ?? "?")=\(w)"]
                    }
                }
                if i < e.values.count { e.currentValue = e.values[i] }
            } else if let b = f as? ICScannerFeatureBoolean {
                b.value = ["1", "true", "on", "yes"].contains(want?.lowercased() ?? "")
            }
        }
        for k in unmatched.keys {
            log("unknown vendor feature \(k)")
            report["vendorErrors"] = (report["vendorErrors"] as? [String] ?? []) + [k]
        }
        return (fu.vendorFeatures ?? []).map(featureDict)
    }

    var lastPct = -100.0
    func pollProgress(_ fu: ICScannerFunctionalUnit) {
        guard !done else { return }
        let p = Double(fu.scanProgressPercentDone)
        if p - lastPct >= 10 { lastPct = p; log("progress \(Int(p))%") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.pollProgress(fu) }
    }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        log("file: \(url.path)")
        scannedFiles.append(url.path)
    }

    // Memory transfer: each band goes into a raw file at its row; a downsampled copy of its rows is printed as
    //   PREVIEW <firstRow> <rows> <width> <height> <base64 RGB8>
    // and the leading edge as "rows <done> <total>", so the app can draw the image while it is being scanned.
    func scannerDevice(_ scanner: ICScannerDevice, didScanTo data: ICScannerBandData) {
        guard let buf = data.dataBuffer else { log("band without data"); return }
        if mem == nil {
            do { mem = try MemoryScan(first: data, out: opts.out, name: opts.name, previewWidth: opts.previewWidth) }
            catch { log("memory scan setup failed: \(error)"); report["scanError"] = "\(error)"; return }
            report["bands"] = ["width": data.fullImageWidth, "height": data.fullImageHeight, "bitsPerPixel": data.bitsPerPixel,
                               "bitsPerComponent": data.bitsPerComponent, "bigEndian": data.isBigEndian, "bytesPerRow": data.bytesPerRow,
                               "profile": data.colorSyncProfilePath ?? ""]
        }
        guard let m = mem else { return }
        m.add(start: data.dataStartRow, rows: data.dataNumRows, bytesPerRow: data.bytesPerRow, buffer: buf)
    }

    var repeatTimes: [Double] = []
    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: (any Error)?) {
        scanning = false
        if error == nil && opts.repeats > repeatTimes.count {        // same session, scan again
            repeatTimes.append(Date().timeIntervalSince(t0))
            report["sessionScanSeconds"] = repeatTimes
            scanner.documentName = opts.name + "_\(repeatTimes.count)"
            t0 = Date(); scanning = true
            scanner.requestScan()
            return
        }
        if !repeatTimes.isEmpty { report["sessionScanSeconds"] = repeatTimes + [Date().timeIntervalSince(t0)] }
        if let m = mem {
            report["bandCount"] = m.bands
            if error == nil {
                do { scannedFiles.append(try m.finish(dpi: opts.dpi, model: scanner.name ?? "EPSON").path) }
                catch { report["scanError"] = "writing TIFF: \(error)" }
            } else { m.discard() }
        }
        report["scanSeconds"] = Date().timeIntervalSince(t0)
        report["files"] = scannedFiles
        if let error { report["scanError"] = "\(error)" }
        emit(report)
        scanner.requestCloseSession()
        finish(error == nil ? 0 : 6)
    }

    // Overview: the driver's quick preview of the whole glass at --dpi, saved as <out>/<name>.png.
    func overview(_ s: ICScannerDevice, _ fu: ICScannerFunctionalUnit) {
        guard fu.canPerformOverviewScan else { report["error"] = "no overview scan"; emit(report); finish(5); return }
        fu.overviewResolution = opts.dpi
        report["requested"] = ["overviewDpi": opts.dpi]
        report["accepted"] = ["overviewDpi": fu.overviewResolution]
        log("overview… accepted=\(fu.overviewResolution) dpi")
        t0 = Date(); scanning = true
        s.requestOverviewScan()
        pollProgress(fu)
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteOverviewScanWithError error: (any Error)?) {
        scanning = false
        report["scanSeconds"] = Date().timeIntervalSince(t0)
        if let error { report["scanError"] = "\(error)" }
        if let img = (scanner.value(forKey: "selectedFunctionalUnit") as? ICScannerFunctionalUnit)?.overviewImage {
            report["size"] = [img.width, img.height]
            try? FileManager.default.createDirectory(at: opts.out, withIntermediateDirectories: true)
            let url = opts.out.appendingPathComponent(opts.name + ".png")
            if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
                CGImageDestinationAddImage(dest, img, nil)
                if CGImageDestinationFinalize(dest) { report["files"] = [url.path] }
            }
        } else { report["error"] = "no overview image" }
        emit(report)
        scanner.requestCloseSession()
        finish(error == nil ? 0 : 6)
    }

    func device(_ device: ICDevice, didEncounterError error: (any Error)?) {
        log("device error: \(String(describing: error))")
    }
}

/// Collects memory-transfer bands into a raw file and writes the finished TIFF with ImageIO
/// (uncompressed: the driver's LZW makes 16-bit files larger, and this TIFF is converted to JPEG XL anyway).
final class MemoryScan {
    let w: Int, h: Int, bpp: Int, bpc: Int, bpr: Int, bigEndian: Bool, profile: String?
    let raw: URL, tiff: URL, fh: FileHandle
    let factor: Int, pw: Int, ph: Int
    var bands = 0, rowsDone = 0

    init(first d: ICScannerBandData, out: URL, name: String, previewWidth: Int) throws {
        w = d.fullImageWidth; h = d.fullImageHeight; bpp = d.bitsPerPixel; bpc = d.bitsPerComponent
        bpr = d.bytesPerRow; bigEndian = d.isBigEndian; profile = d.colorSyncProfilePath
        guard d.numComponents == 3, bpc == 8 || bpc == 16 else { throw NSError(domain: "icprobe", code: 1, userInfo: [NSLocalizedDescriptionKey: "unsupported band format \(d.numComponents)×\(bpc) bit"]) }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        raw = out.appendingPathComponent(name + ".raw"); tiff = out.appendingPathComponent(name + ".tiff")
        FileManager.default.createFile(atPath: raw.path, contents: nil)
        fh = try FileHandle(forWritingTo: raw)
        try fh.truncate(atOffset: UInt64(bpr * h))
        factor = max(1, Int((Double(w) / Double(previewWidth)).rounded(.up)))
        pw = w / factor; ph = h / factor
    }

    func add(start: Int, rows: Int, bytesPerRow: Int, buffer: Data) {
        bands += 1
        do {
            if bytesPerRow == bpr {
                try fh.seek(toOffset: UInt64(start * bpr)); fh.write(buffer)
            } else {                                         // row by row if the band is padded differently
                for r in 0..<rows {
                    try fh.seek(toOffset: UInt64((start + r) * bpr))
                    fh.write(buffer.subdata(in: (r * bytesPerRow)..<(r * bytesPerRow + min(bpr, bytesPerRow))))
                }
            }
        } catch { log("band write failed: \(error)") }
        // preview: nearest pixel of every factor-th row and column, high byte of each sample
        let stride = bpp / 8, hi = bpc == 16 ? (bigEndian ? 0 : 1) : 0, step = bpc / 8
        var py = (start + factor - 1) / factor, first = -1
        var out = Data()
        buffer.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            while py < ph && py * factor < start + rows {
                if first < 0 { first = py }
                let row = (py * factor - start) * bytesPerRow
                for px in 0..<pw {
                    let o = row + px * factor * stride
                    out.append(b[o + hi]); out.append(b[o + step + hi]); out.append(b[o + 2 * step + hi])
                }
                py += 1
            }
        }
        if first >= 0 { log("PREVIEW \(first) \(py - first) \(pw) \(ph) \(out.base64EncodedString())") }
        rowsDone = max(rowsDone, start + rows)
        log("rows \(rowsDone) \(h)")
    }

    func finish(dpi: Int, model: String) throws -> URL {
        try fh.close()
        guard let provider = CGDataProvider(url: raw as CFURL) else { throw err("can't read the band file") }
        let space = profile.flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }.flatMap { CGColorSpace(iccData: $0 as CFData) }
            ?? CGColorSpace(name: CGColorSpace.sRGB)!
        var info = CGImageAlphaInfo.none.rawValue
        if bpc == 16 { info |= bigEndian ? CGBitmapInfo.byteOrder16Big.rawValue : CGBitmapInfo.byteOrder16Little.rawValue }
        guard let img = CGImage(width: w, height: h, bitsPerComponent: bpc, bitsPerPixel: bpp, bytesPerRow: bpr, space: space,
                                bitmapInfo: CGBitmapInfo(rawValue: info), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let dest = CGImageDestinationCreateWithURL(tiff as CFURL, "public.tiff" as CFString, 1, nil) else { throw err("can't build the image") }
        let props: [CFString: Any] = [
            kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi,
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 1, kCGImagePropertyTIFFMake: "EPSON",
                                             kCGImagePropertyTIFFModel: model, kCGImagePropertyTIFFSoftware: "ScanDeck icprobe (memory transfer)"],
        ]
        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw err("TIFF write failed") }
        try? FileManager.default.removeItem(at: raw)
        return tiff
    }

    func discard() { try? fh.close(); try? FileManager.default.removeItem(at: raw) }
    private func err(_ m: String) -> NSError { NSError(domain: "icprobe", code: 2, userInfo: [NSLocalizedDescriptionKey: m]) }
}

// MARK: main
var args = Array(CommandLine.arguments.dropFirst())
let mode: Mode = {
    switch args.first { case "caps": return .caps; case "scan": return .scan; case "overview": return .overview; default: return .list }
}()
if !args.isEmpty { args.removeFirst() }
let probe = Probe(mode: mode)
while let a = args.first {
    args.removeFirst()
    let v = args.first ?? ""
    switch a {
    case "--dpi": probe.opts.dpi = Int(v) ?? 300; args.removeFirst()
    case "--bits": probe.opts.bits = Int(v) ?? 8; args.removeFirst()
    case "--out": probe.opts.out = URL(fileURLWithPath: v); args.removeFirst()
    case "--name": probe.opts.name = v; args.removeFirst()
    case "--transfer": probe.opts.memory = v == "memory"; args.removeFirst()
    case "--repeat": probe.opts.repeats = max(0, Int(v) ?? 0); args.removeFirst()
    case "--preview-width": probe.opts.previewWidth = max(64, Int(v) ?? 640); args.removeFirst()
    case "--set":
        let kv = v.split(separator: "=", maxSplits: 1).map(String.init)
        if kv.count == 2 { probe.opts.vendorSet[kv[0]] = kv[1] } else { log("--set needs NAME=VALUE") }
        args.removeFirst()
    case "--doc": probe.opts.doc = v == "a4" ? 1 : v == "letter" ? 3 : Int(v); args.removeFirst()
    case "--area" where v == "full": probe.opts.fullBed = true; args.removeFirst()
    case "--area":
        let p = v.split(separator: ",").compactMap { Double($0) }
        if p.count == 4 { probe.opts.area = NSRect(x: p[0], y: p[1], width: p[2], height: p[3]) }
        args.removeFirst()
    default: log("unknown arg \(a)")
    }
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { probe.cancel() }
    src.resume()
    signalSources.append(src)
}

probe.start()
let timeout: TimeInterval = mode == .scan || mode == .overview ? 3600 : 30
let deadline = Date().addingTimeInterval(timeout)
while !probe.done && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.25))
}
if !probe.done { log("timed out after \(Int(timeout))s"); emit(probe.report); exit(7) }
exit(probe.exitCode)
