import "pdfjs-dist/web/pdf_viewer.css";
import "./tailwind.css";
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.body });
