/**
 * Text size on this device: the storage key and the values, shared by the no-flash head
 * script in the root layout and the control on /account. Plain module so a Server
 * Component can import it.
 */
export const TEXT_SIZE_KEY = "fleetwise:text-size";
export const TEXT_SIZES = ["normal", "large", "larger"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/**
 * Runs in <head> before first paint. Stamps `data-text` on <html> so globals.css can
 * scale the root font size, and the whole rem-based type scale with it, without a jump
 * after hydration. Wrapped so blocked storage falls through to the standard size.
 */
export const TEXT_SIZE_BOOTSTRAP = `try{var s=localStorage.getItem('${TEXT_SIZE_KEY}');if(s==='large'||s==='larger')document.documentElement.setAttribute('data-text',s)}catch(e){}`;
