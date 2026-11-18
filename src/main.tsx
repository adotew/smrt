import "pdfjs-dist/web/pdf_viewer.css";
import "streamdown/styles.css";
import "./tailwind.css";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import Settings from "./Settings.tsx";

createRoot(document.body).render(location.hash === "#settings" ? <Settings /> : <App />);
