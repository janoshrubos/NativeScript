import { View } from '../core/view';
import { LinearGradient } from './linear-gradient';
import { CoreTypes } from '../../core-types';
import { isDataURI, isFileOrResourcePath, layout, RESOURCE_PREFIX, FILE_PREFIX } from '../../utils';
import { parse } from '../../css-value';
import { path, knownFolders } from '../../file-system';
import * as application from '../../application';
import { profile } from '../../profiling';
import { CSSShadow } from './css-shadow';
import { Length } from './style-properties';
import { BackgroundClearFlags } from './background-common';
export * from './background-common';

interface AndroidView {
	_cachedDrawable: android.graphics.drawable.Drawable.ConstantState | android.graphics.drawable.Drawable;
}

// TODO: Change this implementation to use
// We are using "ad" here to avoid namespace collision with the global android object
export namespace ad {
	let SDK: number;
	function getSDK() {
		if (!SDK) {
			SDK = android.os.Build.VERSION.SDK_INT;
		}

		return SDK;
	}

	function isSetColorFilterOnlyWidget(nativeView: android.view.View): boolean {
		// prettier-ignore
		return (
			nativeView instanceof android.widget.Button
			|| (nativeView instanceof androidx.appcompat.widget.Toolbar && getSDK() >= 21)
			// There is an issue with the DrawableContainer which was fixed
			// for API version 21 and above: https://code.google.com/p/android/issues/detail?id=60183
		);
	}

	export function onBackgroundOrBorderPropertyChanged(view: View) {
		const nativeView = <android.view.View>view.nativeViewProtected;
		if (!nativeView) {
			return;
		}

		const background = view.style.backgroundInternal;

		if (background.clearFlags & BackgroundClearFlags.CLEAR_BOX_SHADOW || background.clearFlags & BackgroundClearFlags.CLEAR_BACKGROUND_COLOR) {
			// clear background if we're clearing the box shadow
			// or the background has been removed
			nativeView.setBackground(null);
		}

		let drawable = nativeView.getBackground();
		const androidView = (<any>view) as AndroidView;
		// use undefined as not set. getBackground will never return undefined only Drawable or null;
		if (androidView._cachedDrawable === undefined && drawable) {
			const constantState = drawable.getConstantState();
			androidView._cachedDrawable = constantState || drawable;
		}
		const isBorderDrawable = drawable instanceof org.nativescript.widgets.BorderDrawable;

		// prettier-ignore
		const onlyColor = !background.hasBorderWidth()
			&& !background.hasBorderRadius()
			&& !background.hasBoxShadow()
			&& !background.clipPath
			&& !background.image
			&& !!background.color;

		if (!isBorderDrawable && drawable instanceof android.graphics.drawable.ColorDrawable && onlyColor) {
			drawable.setColor(background.color.android);
			drawable.invalidateSelf();
		} else if (isSetColorFilterOnlyWidget(nativeView) && drawable && onlyColor) {
			if (isBorderDrawable && androidView._cachedDrawable) {
				if (!(androidView._cachedDrawable instanceof android.graphics.drawable.Drawable.ConstantState)) {
					return;
				}

				drawable = androidView._cachedDrawable.newDrawable(nativeView.getResources());
				nativeView.setBackground(drawable);
			}

			const backgroundColor = ((<any>drawable).backgroundColor = background.color.android);
			drawable.mutate();
			drawable.setColorFilter(backgroundColor, android.graphics.PorterDuff.Mode.SRC_IN);
			drawable.invalidateSelf(); // Make sure the drawable is invalidated. Android forgets to invalidate it in some cases: toolbar
			(<any>drawable).backgroundColor = backgroundColor;
		} else if (!isBorderDrawable && onlyColor) {
			// this is the fastest way to change only background color
			nativeView.setBackgroundColor(background.color.android);
		} else if (!background.isEmpty()) {
			let backgroundDrawable = drawable;

			if (drawable instanceof org.nativescript.widgets.BoxShadowDrawable) {
				// if we have BoxShadow's we have to get the underlying drawable
				backgroundDrawable = drawable.getWrappedDrawable();
			}

			if (backgroundDrawable instanceof org.nativescript.widgets.BorderDrawable) {
				refreshBorderDrawable(view, backgroundDrawable);
			} else {
				backgroundDrawable = new org.nativescript.widgets.BorderDrawable(layout.getDisplayDensity(), view.toString());
				refreshBorderDrawable(view, <org.nativescript.widgets.BorderDrawable>backgroundDrawable);
				nativeView.setBackground(backgroundDrawable);
			}
		} else {
			const cachedDrawable = androidView._cachedDrawable;
			let defaultDrawable: android.graphics.drawable.Drawable = null;
			if (cachedDrawable) {
				if (cachedDrawable instanceof android.graphics.drawable.Drawable.ConstantState) {
					defaultDrawable = cachedDrawable.newDrawable(nativeView.getResources());
				} else if (cachedDrawable instanceof android.graphics.drawable.Drawable) {
					defaultDrawable = cachedDrawable;
				}
			}

			nativeView.setBackground(defaultDrawable);
		}

		if (background.hasBoxShadow()) {
			drawBoxShadow(nativeView, view, background.getBoxShadow());
		}

		// TODO: Can we move BorderWidths as separate native setter?
		// This way we could skip setPadding if borderWidth is not changed.
		const leftPadding = Math.ceil(view.effectiveBorderLeftWidth + view.effectivePaddingLeft);
		const topPadding = Math.ceil(view.effectiveBorderTopWidth + view.effectivePaddingTop);
		const rightPadding = Math.ceil(view.effectiveBorderRightWidth + view.effectivePaddingRight);
		const bottomPadding = Math.ceil(view.effectiveBorderBottomWidth + view.effectivePaddingBottom);

		nativeView.setPadding(leftPadding, topPadding, rightPadding, bottomPadding);

		// reset clear flags
		background.clearFlags = BackgroundClearFlags.NONE;
	}
}

function fromBase64(source: string): android.graphics.Bitmap {
	const bytes = android.util.Base64.decode(source, android.util.Base64.DEFAULT);

	return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
}

function fromGradient(gradient: LinearGradient): org.nativescript.widgets.LinearGradientDefinition {
	const colors = Array.create('int', gradient.colorStops.length);
	const stops = Array.create('float', gradient.colorStops.length);
	let hasStops = false;
	gradient.colorStops.forEach((stop, index) => {
		colors[index] = stop.color.android;
		if (stop.offset) {
			stops[index] = stop.offset.value;
			hasStops = true;
		}
	});

	const alpha = gradient.angle / (Math.PI * 2);
	const startX = Math.pow(Math.sin(Math.PI * (alpha + 0.75)), 2);
	const startY = Math.pow(Math.sin(Math.PI * (alpha + 0.5)), 2);
	const endX = Math.pow(Math.sin(Math.PI * (alpha + 0.25)), 2);
	const endY = Math.pow(Math.sin(Math.PI * alpha), 2);

	return new org.nativescript.widgets.LinearGradientDefinition(startX, startY, endX, endY, colors, hasStops ? stops : null);
}

const pattern = /url\(('|")(.*?)\1\)/;
function refreshBorderDrawable(this: void, view: View, borderDrawable: org.nativescript.widgets.BorderDrawable) {
	const nativeView = <android.view.View>view.nativeViewProtected;
	const context = nativeView.getContext();

	const background = view.style.backgroundInternal;
	if (background) {
		const backgroundPositionParsedCSSValues = createNativeCSSValueArray(background.position);
		const backgroundSizeParsedCSSValues = createNativeCSSValueArray(background.size);
		const blackColor = -16777216; //android.graphics.Color.BLACK;

		let imageUri: string;
		if (background.image && typeof background.image === 'string') {
			imageUri = background.image;
			const match = imageUri.match(pattern);
			if (match && match[2]) {
				imageUri = match[2];
			}
		}

		let bitmap: android.graphics.Bitmap = null;
		if (isDataURI(imageUri)) {
			const base64Data = imageUri.split(',')[1];
			if (base64Data !== undefined) {
				bitmap = fromBase64(base64Data);
				imageUri = null;
			}
		} else if (isFileOrResourcePath(imageUri)) {
			if (imageUri.indexOf(RESOURCE_PREFIX) !== 0) {
				let fileName = imageUri;
				if (fileName.indexOf('~/') === 0) {
					fileName = path.join(knownFolders.currentApp().path, fileName.replace('~/', ''));
				}

				imageUri = FILE_PREFIX + fileName;
			}
		}

		let gradient: org.nativescript.widgets.LinearGradientDefinition = null;
		if (background.image && background.image instanceof LinearGradient) {
			gradient = fromGradient(background.image);
		}

		borderDrawable.refresh(
			background.borderTopColor ? background.borderTopColor.android : blackColor,
			background.borderRightColor ? background.borderRightColor.android : blackColor,
			background.borderBottomColor ? background.borderBottomColor.android : blackColor,
			background.borderLeftColor ? background.borderLeftColor.android : blackColor,

			background.borderTopWidth,
			background.borderRightWidth,
			background.borderBottomWidth,
			background.borderLeftWidth,

			background.borderTopLeftRadius,
			background.borderTopRightRadius,
			background.borderBottomRightRadius,
			background.borderBottomLeftRadius,

			background.clipPath,

			background.color ? background.color.android : 0,
			imageUri,
			bitmap,
			gradient,
			context,
			background.repeat,
			background.position,
			backgroundPositionParsedCSSValues,
			background.size,
			backgroundSizeParsedCSSValues
		);
		//console.log(`>>> ${borderDrawable.toDebugString()}`);
	}
}

function createNativeCSSValueArray(css: string): androidNative.Array<org.nativescript.widgets.CSSValue> {
	if (!css) {
		return null;
	}

	const cssValues = parse(css);
	const nativeArray = Array.create(org.nativescript.widgets.CSSValue, cssValues.length);
	for (let i = 0, length = cssValues.length; i < length; i++) {
		nativeArray[i] = new org.nativescript.widgets.CSSValue(cssValues[i].type, cssValues[i].string, cssValues[i].unit, cssValues[i].value);
	}

	return nativeArray;
}

function drawBoxShadow(nativeView: android.view.View, view: View, boxShadow: CSSShadow) {
	const config = {
		shadowColor: boxShadow.color.android,
		cornerRadius: Length.toDevicePixels(view.borderRadius as CoreTypes.LengthType, 0.0),
		spreadRadius: Length.toDevicePixels(boxShadow.spreadRadius, 0.0),
		blurRadius: Length.toDevicePixels(boxShadow.blurRadius, 0.0),
		offsetX: Length.toDevicePixels(boxShadow.offsetX, 0.0),
		offsetY: Length.toDevicePixels(boxShadow.offsetY, 0.0),
	};
	org.nativescript.widgets.Utils.drawBoxShadow(nativeView, JSON.stringify(config));
}

export enum CacheMode {
	none,
	memory,
	diskAndMemory,
}

let currentCacheMode: CacheMode;
let imageFetcher: org.nativescript.widgets.image.Fetcher;

export function initImageCache(context: android.content.Context, mode = CacheMode.diskAndMemory, memoryCacheSize = 0.25, diskCacheSize: number = 10 * 1024 * 1024): void {
	if (currentCacheMode === mode) {
		return;
	}

	currentCacheMode = mode;
	if (!imageFetcher) {
		imageFetcher = org.nativescript.widgets.image.Fetcher.getInstance(context);
	} else {
		imageFetcher.clearCache();
	}

	const params = new org.nativescript.widgets.image.Cache.CacheParams();
	params.memoryCacheEnabled = mode !== CacheMode.none;
	params.setMemCacheSizePercent(memoryCacheSize); // Set memory cache to % of app memory
	params.diskCacheEnabled = mode === CacheMode.diskAndMemory;
	params.diskCacheSize = diskCacheSize;
	const imageCache = org.nativescript.widgets.image.Cache.getInstance(params);
	imageFetcher.addImageCache(imageCache);
	imageFetcher.initCache();
}

function onLiveSync(args): void {
	if (imageFetcher) {
		imageFetcher.clearCache();
	}
}

global.NativeScriptGlobals.events.on('livesync', onLiveSync);

global.NativeScriptGlobals.addEventWiring(() => {
	application.android.on('activityStarted', (args) => {
		if (!imageFetcher) {
			initImageCache(args.activity);
		} else {
			imageFetcher.initCache();
		}
	});
});

global.NativeScriptGlobals.addEventWiring(() => {
	application.android.on('activityStopped', (args) => {
		if (imageFetcher) {
			imageFetcher.closeCache();
		}
	});
});
