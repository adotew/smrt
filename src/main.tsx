import "pdfjs-dist/web/pdf_viewer.css";
import "streamdown/styles.css";
import "./styles/tailwind.css";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import Settings from "./views/Settings.tsx";

createRoot(document.body).render(location.hash === "#settings" ? <Settings /> : <App />);
