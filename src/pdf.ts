import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

export { pdfjs };

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
// Font and CMap data are read straight from the installed package.
const assets = new URL("../node_modules/pdfjs-dist/", location.href).href;

export const openPDF = (data: Uint8Array) =>
  pdfjs.getDocument({
    data,
    cMapUrl: assets + "cmaps/",
    standardFontDataUrl: assets + "standard_fonts/",
    wasmUrl: assets + "wasm/",
  }).promise;
