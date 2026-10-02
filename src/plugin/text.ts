import {showMessage} from 'siyuan';

/** SiYuan toast/confirm content is HTML; note names and API errors are plain text. */
export function escapeText(text: string): string {
    const element = document.createElement('span'); element.textContent = text; return element.innerHTML;
}
export function showTextMessage(text: string, timeout?: number, type?: 'info' | 'error', id?: string) {
    showMessage(escapeText(text), timeout, type, id);
}
