// Runs in the Figma plugin iframe (DOM context).

interface UiResponse {
  type: "done" | "error";
  message?: string;
  result?: {
    variables: number;
    textStyles: number;
    effectStyles: number;
    skipped: { name: string; reason: string }[];
    fontFallbacks: { name: string; requested: string; used: string }[];
    nonDesignTokens: number;
  };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const textarea = $<HTMLTextAreaElement>("json");
const collectionInput = $<HTMLInputElement>("collection");
const buildSpecCheckbox = $<HTMLInputElement>("build-spec");
const importButton = $<HTMLButtonElement>("import");
const statusEl = $<HTMLDivElement>("status");
const fileInput = $<HTMLInputElement>("file");

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  textarea.value = await file.text();
});

importButton.addEventListener("click", () => {
  if (!textarea.value.trim()) {
    statusEl.textContent = "Paste your tokens.json above first.";
    return;
  }
  statusEl.textContent = "Importing…";
  parent.postMessage(
    {
      pluginMessage: {
        type: "import",
        json: textarea.value,
        collectionName: collectionInput.value || "Tokextract",
        buildSpec: buildSpecCheckbox.checked,
      },
    },
    "*",
  );
});

window.addEventListener("message", (event) => {
  const msg = event.data?.pluginMessage as UiResponse | undefined;
  if (!msg) return;
  if (msg.type === "error") {
    statusEl.textContent = `Error: ${msg.message}`;
    return;
  }
  if (msg.type === "done" && msg.result) {
    const r = msg.result;
    const lines = [
      `${r.variables} variables`,
      `${r.textStyles} text styles`,
      `${r.effectStyles} effect styles`,
      `${r.skipped.length} skipped`,
      `${r.fontFallbacks.length} font fallbacks`,
      `${r.nonDesignTokens} non-tokens ignored`,
    ];
    let html = `<strong>Imported.</strong> ${lines.join(" · ")}`;
    if (r.skipped.length > 0) {
      const details = r.skipped.map((s) => `· ${s.name}: ${s.reason}`).join("\n");
      html += `<details><summary>Skipped tokens</summary><pre>${escapeHtml(details)}</pre></details>`;
    }
    if (r.fontFallbacks.length > 0) {
      const details = r.fontFallbacks
        .map((f) => `· ${f.name}: requested "${f.requested}", used "${f.used}"`)
        .join("\n");
      html += `<details><summary>Font fallbacks used</summary><pre>${escapeHtml(details)}</pre></details>`;
    }
    statusEl.innerHTML = html;
  }
});

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
