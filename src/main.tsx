import { createRoot } from "react-dom/client";
import { App } from "./App";
import { COPY } from "./copy";
import "./styles.css";

document.title = COPY.title;
createRoot(document.getElementById("root")!).render(<App />);
