/** Minimal host API for exercising the real plugin in the browser harness. */
import en from "../i18n/en_US.json";
export const editors: any[] = [];
export const messages: string[] = [];
export const navigation: {calls: Array<{id: string; mobile: boolean}>; onOpen?: (id: string) => void} = {calls: []};
export const openTab = async (options: {doc: {id: string}}) => { navigation.calls.push({id: options.doc.id, mobile: false}); navigation.onOpen?.(options.doc.id); };
export const openMobileFileById = (_app: unknown, id: string) => { navigation.calls.push({id, mobile: true}); navigation.onOpen?.(id); };
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
    dialog?: Dialog;
    failNextOpen = false;
    constructor(private options: {destroyCallback?: () => void; confirmCallback?: () => void}) {}
    addItem(item: any) { this.items.push(item); }
    open(_name: string) {
        if (this.failNextOpen) { this.failNextOpen = false; throw new Error('setting-open failure'); }
        const dialog = new Dialog({content: '<div data-test-settings></div><div class="b3-dialog__action"><button data-setting-cancel>Cancel</button><button data-setting-save>Save</button></div>', destroyCallback: this.options.destroyCallback});
        const content = dialog.element.querySelector('[data-test-settings]')!;
        for (const item of this.items) { const control = item.actionElement ?? item.createActionElement?.(); if (control) content.append(control); }
        dialog.element.querySelector('[data-setting-cancel]')!.addEventListener('click', () => dialog.destroy());
        dialog.element.querySelector('[data-setting-save]')!.addEventListener('click', () => {this.options.confirmCallback?.(); dialog.destroy();});
        this.dialog = dialog;
    }
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
    openSetting() { this.setting?.open(this.name); }
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
