import "pdfjs-dist/web/pdf_viewer.css";
import "./tailwind.css";
import { mount } from "svelte";
import App from "./App.svelte";
import Settings from "./Settings.svelte";

mount(location.hash === "#settings" ? Settings : App, { target: document.body });
