import { html, nothing, render, type TemplateResult } from "lit";
import { CornerDownLeft } from "lucide";
import { mainConversation } from "./conversations";
import { icon } from "./ui";

const newChatState = { open: false, prompt: "" };

let host: HTMLDivElement | null = null;

export function openNewChat(): void {
  if (newChatState.open) return;
  newChatState.open = true;
  newChatState.prompt = "";
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLTextAreaElement>(".new-chat-input")?.focus());
}

export function closeNewChat(): void {
  if (!newChatState.open) return;
  newChatState.open = false;
  newChatState.prompt = "";
  draw();
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "new-chat-host";
    document.body.appendChild(host);
  }
  return host;
}

function draw(): void {
  render(newChatState.open ? paletteTpl() : nothing, ensureHost());
}

function startChat(): void {
  const text = newChatState.prompt.trim();
  closeNewChat();
  const conv = mainConversation();
  conv.newChat();
  if (text) void conv.state.agent?.prompt(text);
}

function onPaletteKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeNewChat();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    startChat();
  }
}

function paletteTpl(): TemplateResult {
  return html`
    <div
      class="chat-search-overlay new-chat-overlay"
      @pointerdown=${(e: PointerEvent) => {
        if (e.target === e.currentTarget) closeNewChat();
      }}
    >
      <div
        class="chat-search-palette new-chat-palette"
        role="dialog"
        aria-label="New chat"
        @keydown=${onPaletteKeydown}
      >
        <div class="chat-search-inputrow new-chat-head">
          <span class="new-chat-title">New chat</span>
          <span class="chat-search-kbd">esc</span>
        </div>
        <textarea
          class="new-chat-input"
          placeholder="What do you want to work on?"
          spellcheck="false"
          aria-label="What do you want to work on?"
          .value=${newChatState.prompt}
          @input=${(e: InputEvent) => {
            newChatState.prompt = (e.currentTarget as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="chat-search-foot new-chat-foot">
          <span><span class="chat-search-kbd">⇧↵</span> new line</span>
          <button class="btn primary new-chat-start" type="button" @click=${startChat}>
            Start chat ${icon(CornerDownLeft, 13)}
          </button>
        </div>
      </div>
    </div>
  `;
}
