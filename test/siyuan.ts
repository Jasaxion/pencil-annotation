/** Minimal host API for exercising the real plugin in the browser harness. */
import en from "../i18n/en_US.json";
export const editors: any[] = [];
export const messages: string[] = [];
export const getAllEditor = () => editors;
export const getFrontend = () => "browser-desktop";
export const showMessage = (message: string) => { messages.push(message); };
export const confirmationControl: {answer: boolean | null; calls: Array<{message: string; accept: () => void; cancel: () => void}>} = {answer: true, calls: []};
export const confirm = (_title: string, message: string, callback: () => void, cancel: () => void = () => {}) => {
    confirmationControl.calls.push({message, accept: callback, cancel});
    if (confirmationControl.answer === true) callback(); else if (confirmationControl.answer === false) cancel();
};
export const fetchSyncPost = async (url: string, data: unknown) => (await fetch(url, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data),
})).json();
export class Setting {
    items: any[] = [];
    constructor(_options: unknown) {}
    addItem(item: any) { this.items.push(item); }
}
export class Plugin {
    name = "pencil-annotation";
    i18n = en;
    setting: any;
    private events = new EventTarget();
    eventBus = {
        on: (name: string, cb: EventListener) => this.events.addEventListener(name, cb),
        off: (name: string, cb: EventListener) => this.events.removeEventListener(name, cb),
        emit: (name: string, detail: unknown) => this.events.dispatchEvent(new CustomEvent(name, {detail})),
    };
    data: Record<string, unknown> = {};
    loadData = async (name: string) => this.data[name];
    saveData = async (name: string, value: unknown) => { this.data[name] = value; return {code: 0}; };
    addTopBar(_options: unknown) {}
    addCommand(_options: unknown) {}
    openSetting() {}
}
export class Dialog {
    element = document.createElement("div");
    private options: {content: string; destroyCallback?: () => void};
    constructor(options: {content: string; destroyCallback?: () => void}) {
        this.options = options; this.element.className = "b3-dialog";
        this.element.style.cssText = "position:fixed;inset:16px;max-width:560px;margin:auto;overflow:auto;background:white;z-index:6000";
        this.element.innerHTML = options.content; document.body.append(this.element);
    }
    destroy() { this.options.destroyCallback?.(); this.element.remove(); }
}
export const ProtyleMethod = {
    mathRender() { throw new Error("Use the real-host test for math rendering"); },
    mermaidRender() {}, flowchartRender() {}, graphvizRender() {}, chartRender() {}, abcRender() {}, plantumlRender() {}, mindmapRender() {},
};
