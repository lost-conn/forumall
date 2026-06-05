// Install the browser Buffer shim BEFORE any module that touches signing
// (@forumall/shared encodes keys/sigs through Node's Buffer).
import "./lib/buffer-polyfill.ts";
import "uno.css";
import { render } from "solid-js/web";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

render(() => <App />, root);
