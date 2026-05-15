// useCdnMonitor.js — removido: CDN monitor causava chamadas extras desnecessárias
export function useCdnMonitor() { return { cdnPaused: false, cdnStatus: null }; }
export function isCdnError() { return false; }
