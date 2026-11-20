import { App } from "./ui/app.js";

/** The studio page. Everything it shows comes from the server as JSON; everything it does is an action sent back. */
const root = document.getElementById("app")!;
const app = new App(root);
app.start().catch((e: unknown) => {
  root.innerHTML = "";
  const p = document.createElement("p");
  p.className = "fatal";
  p.textContent = `The studio could not start: ${(e as Error).message}`;
  root.appendChild(p);
});
