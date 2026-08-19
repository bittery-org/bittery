import { useLayoutEffect, useRef } from "react";

/**
 * Report this frame's content height to the content script so it can size the
 * iframe to the card.
 *
 * The observer is attached to `<html>` rather than `<body>` so margins collapse
 * into the measurement, and the last reported value is remembered so a resize
 * that doesn't change the height costs one comparison instead of a
 * cross-document `postMessage` and an iframe style write.
 */
export function useOverlayHeight(nonce: string): void {
	const lastHeight = useRef(-1);

	useLayoutEffect(() => {
		const report = () => {
			const height = Math.ceil(document.documentElement.scrollHeight);
			if (height === lastHeight.current || height <= 0) return;
			lastHeight.current = height;
			window.parent.postMessage({ type: "RESIZE_IFRAME", height, nonce }, "*");
		};

		report();
		const observer = new ResizeObserver(report);
		observer.observe(document.documentElement);
		return () => observer.disconnect();
	}, [nonce]);
}
