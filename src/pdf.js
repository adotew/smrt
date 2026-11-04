import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

export { pdfjs };

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
// Font and CMap data are read straight from the installed package.
const assets = new URL("../node_modules/pdfjs-dist/", location.href).href;

export const openPDF = (data) =>
  pdfjs.getDocument({
    data,
    cMapUrl: assets + "cmaps/",
    standardFontDataUrl: assets + "standard_fonts/",
    wasmUrl: assets + "wasm/",
  }).promise;

/** Page 1 as a data URL whose longer side is `size` CSS pixels. */
// shortcut: reads and renders the whole file every time a folder opens; cache covers if large libraries feel slow.
export async function renderCover(data, size) {
  const doc = await openPDF(data);
  try {
    const page = await doc.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (size * (window.devicePixelRatio || 1)) / Math.max(width, height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas.toDataURL();
  } finally {
    doc.loadingTask.destroy();
  }
}
