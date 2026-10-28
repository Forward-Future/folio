import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "./pdf";
import type { PageViewport } from "pdfjs-dist";
import { Modal } from "./Dialogs";
import { cleanSignature, fitSignature, readSignature, type SignatureImage, type SignatureTarget } from "./signatures";

export function SignatureDialog({ pdf, pageNumber, targets, onApprove, onClose }: {
  pdf: PDFDocumentProxy; pageNumber: number; targets: SignatureTarget[];
  onApprove: (signature: SignatureImage, rect: number[]) => Promise<void>; onClose: () => void;
}) {
  const [signature, setSignature] = useState<SignatureImage | null>(readSignature);
  const [saved, setSaved] = useState(() => !!readSignature());
  const [remember, setRemember] = useState(false);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [crop, setCrop] = useState<number[] | null>(null);
  const [threshold, setThreshold] = useState(180);
  const [camera, setCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState(targets[0]?.id || "manual");
  const [manualRect, setManualRect] = useState<number[] | null>(null);
  const [size, setSize] = useState(150);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; viewport: PageViewport } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cropCanvas = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureGeneration = useRef(0);
  const mounted = useRef(true);
  const dragStart = useRef<number[] | null>(null);
  const selected = targets.find(target => target.id === targetId);
  const bounds = selected?.rect || manualRect;
  const rect = signature && bounds ? fitSignature(signature, bounds) : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; captureGeneration.current++; streamRef.current?.getTracks().forEach(track => track.stop()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let render: { cancel: () => void } | undefined;
    void (async () => {
      const page = await pdf.getPage(pageNumber);
      const native = page.getViewport({ scale: 1, rotation: 0 });
      const viewport = page.getViewport({ scale: Math.min(480 / native.width, 580 / native.height), rotation: 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      if (cancelled) return;
      const task = page.render({ canvas, viewport }); render = task;
      await task.promise;
      if (!cancelled) setPreview({ url: canvas.toDataURL(), width: viewport.width, height: viewport.height, viewport });
    })().catch(reason => { if (!cancelled) setError("Couldn't preview this page: " + String(reason)); });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pageNumber]);

  useEffect(() => {
    if (camera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => setError("Camera preview couldn't start. Try uploading a photo instead."));
    }
  }, [camera]);

  useEffect(() => {
    if (!source || !cropCanvas.current) return;
    const canvas = cropCanvas.current;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(source, 0, 0);
    if (crop) { context.strokeStyle = "#2f6fed"; context.lineWidth = Math.max(2, source.width / 250); context.strokeRect(crop[0], crop[1], crop[2], crop[3]); }
  }, [source, crop]);

  useEffect(() => {
    if (!source || !crop) return;
    const timer = setTimeout(() => {
      try { setSignature(cleanSignature(source, crop, threshold)); setError(""); }
      catch (reason) { setSignature(null); setError((reason as Error).message); }
    }, 80);
    return () => clearTimeout(timer);
  }, [source, crop, threshold]);

  const stopCamera = () => {
    captureGeneration.current++;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    setCamera(false); setCameraReady(false);
  };
  const startCamera = async () => {
    const generation = ++captureGeneration.current;
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera isn't available. Upload a photo instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      if (!mounted.current || generation !== captureGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = stream; setCamera(true);
    } catch (reason) { if (mounted.current && generation === captureGeneration.current) setError("Couldn't access the camera. Check Windows camera permissions or upload a photo. " + (reason as Error).message); }
  };
  const acceptSource = (image: CanvasImageSource, width: number, height: number) => {
    const factor = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(width * factor); canvas.height = Math.round(height * factor);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    setSource(canvas); setCrop([0, 0, canvas.width, canvas.height]); setRemember(false); setSignature(null); setError("");
  };
  const capture = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    acceptSource(video, video.videoWidth, video.videoHeight); stopCamera();
  };
  const upload = async (file?: File) => {
    if (!file) return;
    stopCamera();
    const generation = ++captureGeneration.current;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Please use a photo smaller than 20 MB.");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
      const bitmap = await createImageBitmap(file);
      try { if (mounted.current && generation === captureGeneration.current) acceptSource(bitmap, bitmap.width, bitmap.height); }
      finally { bitmap.close(); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
  };
  const cropPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(event.currentTarget.width, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)),
      Math.max(0, Math.min(event.currentTarget.height, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height))];
  };
  const approve = async () => {
    if (!signature || !rect || busy || source || camera) return;
    setBusy(true); setError("");
    try {
      await onApprove(signature, rect);
      if (remember) {
        try { localStorage.setItem("folio:signature", JSON.stringify(signature)); }
        catch { setError("Signature added, but couldn't remember it on this device. Close to continue."); setBusy(false); return; }
      }
      onClose();
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  };
  const screenRect = preview && rect ? [...preview.viewport.convertToViewportPoint(rect[0], rect[1]), ...preview.viewport.convertToViewportPoint(rect[2], rect[3])] : null;

  return <Modal title={"Sign page " + pageNumber} onClose={() => { if (!busy) onClose(); }}>
    <div className="signature-dialog">
      <p className="search-hint">Sign white paper with dark ink, then capture or upload a photo. Nothing is sent to a server. This adds a visual signature, not a digital certificate.</p>
      <fieldset disabled={busy} className="signature-controls">
        <div className="form-actions">
          <button className="btn ghost" onClick={() => void startCamera()}>Use camera</button>
          <label className="btn ghost">Upload photo<input aria-label="Upload signature photo" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
          {saved && <button className="btn ghost" onClick={() => { try { localStorage.removeItem("folio:signature"); setSaved(false); setSignature(null); setSource(null); setRemember(false); } catch { setError("Couldn't forget this signature. Please try again."); } }}>Forget saved signature</button>}
        </div>
        {camera && <div className="signature-camera"><video ref={videoRef} muted playsInline onLoadedData={() => setCameraReady(true)} /><div className="form-actions"><button className="btn primary" disabled={!cameraReady} onClick={capture}>Capture paper</button><button className="btn ghost" onClick={stopCamera}>Stop camera</button></div></div>}
        {source && <div className="signature-crop">
          <p>Drag a box tightly around your signature, avoiding paper edges and shadows.</p>
          <canvas ref={cropCanvas} aria-label="Crop signature photo" onPointerDown={event => { dragStart.current = cropPoint(event); event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={event => { if (!dragStart.current) return; const point = cropPoint(event); setCrop([Math.min(point[0], dragStart.current[0]), Math.min(point[1], dragStart.current[1]), Math.max(1, Math.abs(point[0] - dragStart.current[0])), Math.max(1, Math.abs(point[1] - dragStart.current[1]))]); }}
            onPointerUp={() => { dragStart.current = null; }} onPointerCancel={() => { dragStart.current = null; }} />
          <label>Ink sensitivity <input aria-label="Ink sensitivity" type="range" min="70" max="245" value={threshold} onChange={event => setThreshold(+event.target.value)} /></label>
          <button className="btn primary" disabled={!signature} onClick={() => {
            try { setSignature(cleanSignature(source, crop!, threshold)); setSource(null); setError(""); }
            catch (reason) { setError((reason as Error).message); }
          }}>Use this signature</button>
        </div>}
        {signature && <div className="signature-image"><img src={signature.url} alt="Your signature preview" /></div>}
        {signature && !source && !camera && <>
          <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /> Remember this signature on this device</label>
          <label>Placement <select aria-label="Signature placement" value={targetId} onChange={event => setTargetId(event.target.value)}>
            {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}<option value="manual">Choose a position on this page</option>
          </select></label>
          {selected?.kind === "label" && <p className="search-hint">Possible signature label found. Check the suggested position carefully.</p>}
          {targetId === "manual" && <><p>Click the page preview to position your signature.</p><label>Signature width <input aria-label="Signature width" type="range" min="40" max="300" value={size} onChange={event => { setSize(+event.target.value); setManualRect(null); }} /></label></>}
          {preview && <div className="signature-page" style={{ width: preview.width, aspectRatio: preview.width / preview.height }} onClick={event => {
            if (targetId !== "manual") return;
            const area = event.currentTarget.getBoundingClientRect();
            const [pointX, pointY] = preview.viewport.convertToPdfPoint((event.clientX - area.left) * preview.width / area.width, (event.clientY - area.top) * preview.height / area.height);
            const [left, bottom, right, top] = preview.viewport.viewBox;
            const width = Math.min(size, right - left, (top - bottom) * signature.width / signature.height);
            const height = width * signature.height / signature.width;
            const positionX = Math.max(left, Math.min(right - width, pointX - width / 2));
            const positionY = Math.max(bottom, Math.min(top - height, pointY - height / 2));
            setManualRect([positionX, positionY, positionX + width, positionY + height]);
          }}><img className="signature-page-background" src={preview.url} alt={"Page " + pageNumber + " placement preview"} />
            {screenRect && <img className="signature-placement" src={signature.url} alt="Proposed signature location" style={{ left: Math.min(screenRect[0], screenRect[2]) / preview.width * 100 + "%", top: Math.min(screenRect[1], screenRect[3]) / preview.height * 100 + "%", width: Math.abs(screenRect[2] - screenRect[0]) / preview.width * 100 + "%", height: Math.abs(screenRect[3] - screenRect[1]) / preview.height * 100 + "%" }} />}
          </div>}
        </>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={!signature || !rect || !preview || !!source || camera || busy} onClick={() => void approve()}>{busy ? "Adding signature..." : "Approve and add signature"}</button></div>
      <p className="search-hint">Only approval adds the signature. Use Ctrl+Z to undo; Save copy exports the signed PDF. Changes can affect existing digital signatures. Remembered signatures are unencrypted in this Windows profile; use Forget to remove them.</p>
    </div>
  </Modal>;
}
