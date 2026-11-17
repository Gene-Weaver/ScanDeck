// qrtool: QR codes with macOS's own frameworks (no downloads).
//   qrtool read <image>            Vision (the reader behind Chromium's BarcodeDetector on macOS).
//                                  Prints {"codes":[{"value":"…","box":[x,y,w,h]}]}, box in pixels from the top-left.
//   qrtool make <text> <out.png>   Core Image's QR generator: one pixel per module, error correction M.
//                                  Prints {"modules":<pixels across, including its 1-module border>}.
// Build: npm run probe:build
import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }
func emit(_ o: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!) }

let a = CommandLine.arguments
if a.count >= 3 && a[1] == "read" {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read \(a[2])") }
  let req = VNDetectBarcodesRequest()
  req.symbologies = [.qr]
  do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) } catch { fail("Vision: \(error.localizedDescription)") }
  let w = Double(img.width), h = Double(img.height)
  let codes: [[String: Any]] = (req.results ?? []).compactMap { o in
    guard let v = o.payloadStringValue else { return nil }
    let b = o.boundingBox                                   // normalized, origin bottom-left
    return ["value": v, "box": [(b.minX * w).rounded(), ((1 - b.maxY) * h).rounded(), (b.width * w).rounded(), (b.height * h).rounded()]]
  }
  emit(["codes": codes])
} else if a.count >= 4 && a[1] == "make" {
  guard let f = CIFilter(name: "CIQRCodeGenerator") else { fail("no QR generator") }
  f.setValue(a[2].data(using: .utf8)!, forKey: "inputMessage")
  f.setValue("M", forKey: "inputCorrectionLevel")
  guard let out = f.outputImage, let cg = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(out, from: out.extent) else { fail("could not make the QR code") }
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[3]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(a[3])") }
  CGImageDestinationAddImage(dest, cg, nil)
  if !CGImageDestinationFinalize(dest) { fail("cannot write \(a[3])") }
  emit(["modules": cg.width])
} else {
  fail("usage: qrtool read <image> | qrtool make <text> <out.png>")
}
