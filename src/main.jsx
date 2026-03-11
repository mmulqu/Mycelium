import React from "react";
import ReactDOM from "react-dom/client";
import CollageWorkspace from "./collage-app.jsx";
import "./index.css";

// Polyfill window.storage for browser (localStorage-backed)
// This stands in for the Tauri storage API until the desktop shell is built.
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key);
      return value !== null ? { value } : null;
    },
    async set(key, value) {
      localStorage.setItem(key, value);
    },
    async delete(key) {
      localStorage.removeItem(key);
    },
  };
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CollageWorkspace />
  </React.StrictMode>
);
