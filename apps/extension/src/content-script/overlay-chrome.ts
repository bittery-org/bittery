/**
 * Visual chrome for in-page overlay hosts.
 *
 * The floating card lives inside a transparent iframe, which creates two
 * problems if the card draws its own drop shadow:
 *
 * 1. **The shadow gets clipped.** Anything painted outside the iframe's box is
 *    cut off, so a soft shadow ends in a hard rectangle — visible as a grey halo
 *    with a straight edge around the card.
 * 2. **Reserving room for it steals clicks.** Padding the iframe out so the
 *    shadow fits means a band of transparent-but-still-hit-testable iframe
 *    around the card, swallowing clicks meant for the page underneath.
 *
 * So the shadow is drawn by the *host* element instead. A `box-shadow` renders
 * outside its element's box, is never hit-tested, and follows the host's
 * `border-radius` — which gives an unclipped shadow with the iframe sized
 * exactly to the card.
 */

/** Matches `--radius` (0.625rem) so the shadow follows the card's corners. */
export const OVERLAY_RADIUS_PX = 10;

/**
 * Deliberately tighter than the popup's `shadow-pop`: this sits on someone
 * else's page, where a large ambient shadow reads as intrusive rather than
 * elevated. The card's own hairline border supplies the ring.
 */
const OVERLAY_SHADOW =
	"0 6px 20px oklch(0 0 0 / 0.20), 0 2px 6px oklch(0 0 0 / 0.12)";

/** Apply the shared host styling (radius + shadow) to an overlay shadow host. */
export function applyOverlayHostChrome(host: HTMLElement): void {
	host.style.borderRadius = `${OVERLAY_RADIUS_PX}px`;
	host.style.boxShadow = OVERLAY_SHADOW;
}

/** Round the iframe to match, so the card's corners aren't boxed in. */
export function applyOverlayFrameChrome(iframe: HTMLIFrameElement): void {
	iframe.style.borderRadius = `${OVERLAY_RADIUS_PX}px`;
	iframe.style.overflow = "hidden";
}
