/* By Morgan McGuire @CasualEffects https://casual-effects.com LGPL 3.0 License */
// Web software host implementation of the runtime back end

"use strict";

// The gif recording object, if in a recording
let gifRecording = null;

let _ch_audioContext;

console.assert(window.location.toString().substr(0, 7) !== "file://", 'nano cannot run from a local filesystem. It requires a web server (which may be local...see the manual)');

window.AudioContext = window.AudioContext || window.webkitAudioContext;
console.assert(window.AudioContext);
try {
    _ch_audioContext = new AudioContext();
    _ch_audioContext.gainNode = _ch_audioContext.createGain();
    _ch_audioContext.gainNode.gain.value = 0.2;
    _ch_audioContext.gainNode.connect(_ch_audioContext.destination);
} catch(e) {
    console.log(e);
}


/************** Emulator event handling ******************************/
let emulatorKeyState = {};
let emulatorKeyJustPressed = {};
let emulatorKeyJustReleased = {};

const screenshotKey = 117; // F6
const gifCaptureKey = 119; // F8

function makeFilename(s) {
    return s.replace(/\s|:/g, '_').replace(/[^A-Za-z0-9_\.\(\)=\-\+]/g, '').replace(/_+/g, '_');
}

function onEmulatorKeyDown(event) {
    event.stopPropagation();
    event.preventDefault();

    // On browsers that support it, ignore
    // synthetic repeat events
    if (event.repeat) { return; }

    const key = event.which || event.keyCode;
    if ((key === 67) && (event.ctrlKey || event.metaKey)) {
        // Ctrl+C
        onPauseButton();
        return;
    }

    emulatorKeyState[key] = true;
    emulatorKeyJustPressed[key] = true;

    // Pass event to the main IDE
    onDocumentKeyDown(event);
}


function downloadScreenshot() {
    // Screenshot
    // , hour:'2-digit', minute:'2-digit'
    download(emulatorScreen.toDataURL(), makeFilename(gameSource.constants.assetCredits.title + '-' + new Date().toLocaleString(undefined, {year: 'numeric', month: 'short', day: 'numeric'})) + '.png');
}


const PREVIEW_FRAMES_X = 6;
const PREVIEW_FRAMES_Y = 10;

function startPreviewRecording() {
    if (! previewRecording) {
        // Force 20 fps
        Runtime._graphicsPeriod = 3;
        previewRecording = new Uint32Array(192 * 112 * PREVIEW_FRAMES_X * PREVIEW_FRAMES_Y);
        previewRecordingFrame = 0;
    }
}


function processPreviewRecording() {
    const targetX = (previewRecordingFrame % PREVIEW_FRAMES_X) * 192;
    const targetY = Math.floor(previewRecordingFrame / PREVIEW_FRAMES_X) * 112;

    // Process differently depending on the screen resolution
    if (SCREEN_WIDTH === 384 && SCREEN_HEIGHT === 224) {
        // Full resolution. Average pixels down.
        for (let y = 0; y < 112; ++y) {
            let dstOffset = (y + targetY) * 192 * PREVIEW_FRAMES_X + targetX;
            for (let x = 0; x < 192; ++dstOffset, ++x) {
                // Average four pixels
                let r = 0, g = 0, b = 0;

                for (let dy = 0; dy <= 1; ++dy) {
                    for (let dx = 0; dx <= 1; ++dx) {
                        const src = Runtime._screen[(x*2 + dx) + (y*2 + dy) * 384];
                        r += (src >>> 16) & 0xff;
                        g += (src >>> 8) & 0xff;
                        b += src & 0xff;
                    } // dx
                } // dy

                previewRecording[dstOffset] = (((r >> 2) & 0xff) << 16) + (((g >> 2) & 0xff) << 8) + ((b >> 2) & 0xff);
            } // x
        } // y
    } else if (SCREEN_WIDTH === 192 && SCREEN_HEIGHT === 112) {
        // Half-resolution. Copy lines directly
        for (let y = 0; y < 112; ++y) {
            previewRecording.set(Runtime._screen.slice(y * 192, (y + 1) * 192), targetX + (targetY + y) * 192 * PREVIEW_FRAMES_X);
        }
    } else if (SCREEN_WIDTH === 128 && SCREEN_HEIGHT === 128) {
        // 128x128. Crop
        for (let y = 0; y < 112; ++y) {
            previewRecording.set(Runtime._screen.slice((y + 8) * 128, (y + 9) * 128), (targetX + 32) + (targetY + y) * 192 * PREVIEW_FRAMES_X);
        }
    } else if (SCREEN_WIDTH === 128 && SCREEN_HEIGHT === 128) {
        // 64x64. Copy
        for (let y = 0; y < 64; ++y) {
            previewRecording.set(Runtime._screen.slice(y * 64, (y + 1) * 64), (targetX + 64) + (targetY + y + 64) * 192 * PREVIEW_FRAMES_X);
        }
    } else {
        alert('Preview recording not supported at this resolution');
        throw new Error('Preview recording not supported at this resolution');
    }
    
    ++previewRecordingFrame;
    if (previewRecordingFrame >= PREVIEW_FRAMES_X * PREVIEW_FRAMES_Y) {
        // Set the alpha channel and reduce to 4:4:4
        for (let i = 0; i < previewRecording.length; ++i) {
            const c = previewRecording[i];
            const r = (c >>> 20) & 0xf;
            const g = (c >>> 12) & 0xf;
            const b = (c >>> 4)  & 0xf;
            previewRecording[i] = 0xff000000 | (r << 20) | (r << 16) | (g << 12) | (g << 8) | (b << 4) | b;
        }
        
        // Copy over data to a canvas
        const img = document.createElement('canvas');
        img.width = 192 * PREVIEW_FRAMES_X; img.height = 112 * PREVIEW_FRAMES_Y;
        const ctx = img.getContext('2d');
        const data = ctx.createImageData(img.width, img.height);
        new Uint32Array(data.data.buffer).set(previewRecording);
        ctx.putImageData(data, 0, 0);

        // Display the result
        img.toBlob(function (blob) { window.open(URL.createObjectURL(blob)); });
        previewRecordingFrame = 0;
        previewRecording = null;
    }
}


let gifCtx = null;

function startGIFRecording() {
    if (! gifRecording) {
        document.getElementById('recording').innerHTML = 'RECORDING';
        document.getElementById('recording').classList.remove('hidden');
        const baseScale = 1;
        const scale = ((updateImage.width <= 384/2) ? 2 : 1) * baseScale;
        gifRecording = new GIF({workers:4, quality:3, dither:false, width: scale * updateImage.width, height: scale * updateImage.height});
        gifRecording.frameNum = 0;

        gifRecording.scale = scale;
        if (gifRecording.scale > 1) {
            const gifImage = document.createElement('canvas');
            gifImage.width = gifRecording.scale * updateImage.width;
            gifImage.height = gifRecording.scale * updateImage.height;
            gifCtx = gifImage.getContext("2d");
            gifCtx.msImageSmoothingEnabled = gifCtx.webkitImageSmoothingEnabled = gifCtx.imageSmoothingEnabled = false;
        }
        
        gifRecording.on('finished', function (blob) {
            window.open(URL.createObjectURL(blob));
            document.getElementById('recording').innerHTML = '';
            document.getElementById('recording').classList.add('hidden');
            gifCtx = null;
        });
    }
}


function stopGIFRecording() {
    if (gifRecording) {
        // Save
        document.getElementById('recording').innerHTML = 'Encoding GIF…';
        gifRecording.render();
        gifRecording = null;
    }
}


function toggleGIFRecording() {
    if (gifRecording) {
        stopGIFRecording();
    } else {
        startGIFRecording();
    }
}


function onEmulatorKeyUp(event) {
    const key = event.which || event.keyCode;
    emulatorKeyState[key] = false;
    emulatorKeyJustReleased[key] = true;
    event.stopPropagation();
    event.preventDefault();
}

const emulatorKeyboardInput = document.getElementById('emulatorKeyboardInput');
emulatorKeyboardInput.addEventListener('keydown', onEmulatorKeyDown, false);
emulatorKeyboardInput.addEventListener('keyup', onEmulatorKeyUp, false);

/** Returns the ascii code of this character */
function ascii(x) { return x.charCodeAt(0); }

/** Used by _submitFrame() to map axes and buttons to event key codes when sampling the keyboard controller */
const keyMap = [{'-x':[ascii('A'), 37],         '+x':[ascii('D'), 39],          '-y':[ascii('W'), 38], '+y':[ascii('S'), 40],          a:[ascii('V'), 32], b:[ascii('G'), 13],  c:[ascii('C'), ascii('C')], d:[ascii('F'), ascii('F')], q:[ascii('1'), ascii('Q')], p:[ascii('4'), ascii('P')]},
                {'-x':[ascii('J'), ascii('J')], '+x':[ascii('L'), ascii('L')],  '-y':[ascii('I')],     '+y':[ascii('K'), ascii('K')],  a:[191, 191],       b:[222, 222],        c:[190, 190],               d:[186, 186],               q:[ascii('7'), ascii('7')], p:[ascii('0'), ascii('0')]}];

let prevRealGamepadState = [];

// Maps names of gamepads to arrays for mapping standard buttons
// to that gamepad's buttons
const gamepadRemap = {
    'identity':                                    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    'SNES30 Joy     (Vendor: 2dc8 Product: ab20)': [1, 0, 4, 3, 6, 7, 5, 2,10,11, 8, 9,   12, 13, 14, 15, 16]
};

function getIdealGamepads() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : (navigator.webkitGetGamepads ? navigator.webkitGetGamepads : []);
    let gamepadArray = [];
    // Center of gamepad
    const deadZone = 0.2;
    
    // Compact gamepads array and perform thresholding
    for (let i = 0; i < gamepads.length; ++i) {
        let pad = gamepads[i];
        if (pad && pad.connected) {
            // Construct a simplified web gamepad API
	    const remap = gamepadRemap[pad.id] || gamepadRemap.identity;
            let mypad = {axes:[0, 0, 0, 0], buttons:[]};
            for (let a = 0; a < Math.min(4, pad.axes.length); ++a) {
                mypad.axes[a] = (Math.abs(pad.axes[a]) > deadZone) ? Math.sign(pad.axes[a]) : 0;
            }
            
            // Process all 17 buttons/axes as digital buttons first 
            for (let b = 0; b < 17; ++b) {
                const button = pad.buttons[remap[b]];
                // Different browsers follow different APIs for the value of buttons
                mypad.buttons[b] = (typeof button === 'object') ? button.pressed : (button >= 0.5);
            }

            // D-pad is buttons U = 12, D = 13, L = 14, R = 15.
            // Use it to override the axes right here.
            if (mypad.buttons[15]) {
                mypad.axes[0] = +1;
            } else if (mypad.buttons[14]) {
                mypad.axes[0] = -1;
            }

            if (mypad.buttons[12]) {
                mypad.axes[1] = -1;
            } else if (mypad.buttons[13]) {
                mypad.axes[1] = +1;
            }

            gamepadArray.push(mypad);
            
            if (gamepadArray.length > prevRealGamepadState.length) {
                prevRealGamepadState.push({axes:[0, 0, 0, 0], 
                    buttons:[false, false, false, false, // 0-3: ABXY buttons
                             false, false, false, false, // 4-7: LB,RB,LT,RT
                             false, false, // 8 & 9: start + select
                             false, false, // 10 & 11: LS, RS
                             false, false, false, false // 12-15: D-pad
                             ]});
            }
        }
    }

    return gamepadArray;
}

let emulatorButtonState = {};

////////////////////////////////////////////////////////////////////////////////////
//
// Sounds

/** All sound sources that are playing */
let activeSoundHandleMap = new Map();
let pausedSoundHandleArray = null;

function soundSourceOnEnded() {
    this.resumePositionMs = Date.now() - this.startTimeMs;
    activeSoundHandleMap.delete(this.handle);
}


function internalSoundSourcePlay(handle, audioClip, startPositionMs, loop, volume, pitch, pan) {
    // A new source must be created every time that the sound is played
    const source = _ch_audioContext.createBufferSource();
    source.buffer = audioClip.buffer;

    if (_ch_audioContext.createStereoPanner) {
        source.panNode = _ch_audioContext.createStereoPanner();
        source.panNode.pan.setValueAtTime(pan, _ch_audioContext.currentTime);
    } else {
        source.panNode = _ch_audioContext.createPanner();
        source.panNode.panningModel = 'equalpower';
        source.panNode.setPosition(pan, 0, 1 - Math.abs(pan));
    }
    source.gainNode = _ch_audioContext.createGain();
    source.gainNode.gain.setValueAtTime(volume, _ch_audioContext.currentTime);

    source.connect(source.panNode);
    source.panNode.connect(source.gainNode);
    source.gainNode.connect(_ch_audioContext.gainNode);
    
    source.onended = soundSourceOnEnded;
    
    if (! source.start) {
        // Backwards compatibility
        source.start = source.noteOn;
        source.stop  = source.noteOff;
    }
    
    source.handle = handle;
    source.audioClip = audioClip;
    source.loop = loop;
    source.pitch = pitch;
    source.volume = volume;
    source.pan = pan;
    source.startTimeMs = Date.now() - startPositionMs;

    if (source.detune) {
        // Doesn't work on Safari
        source.detune.setValueAtTime((pitch - 1) * 1200, _ch_audioContext.currentTime);
    }

    activeSoundHandleMap.set(handle, true);
    handle._ = source;

    source.start(0, (startPositionMs % (source.buffer.duration * 1000)) / 1000);

    return handle;
}

// In seconds
const audioRampTime = 1 / 60;

function setSoundVolume(handle, volume) {
    if (! (handle && handle._)) {
        throw new Error("Must call setSoundVolume() on a sound returned from playAudioClip()");
    }
    handle._.volume = volume;
    handle._.gainNode.gain.linearRampToValueAtTime(volume, _ch_audioContext.currentTime + audioRampTime);
}


function setSoundPan(handle, pan) {
    if (! (handle && handle._)) {
        throw new Error("Must call setSoundPan() on a sound returned from playAudioClip()");
    }
    handle._.pan = pan;
    if (handle._.panNode.pan) {
        handle._.panNode.pan.linearRampToValueAtTime(pan, _ch_audioContext.currentTime + audioRampTime);
    } else {
        // Safari fallback
        handle._.panNode.setPosition(pan, 0, 1 - Math.abs(pan));
    }
}


function setSoundPitch(handle, pitch) {
    if (! (handle && handle._)) {
        throw new Error("Must call setSoundPitch() on a sound returned from playAudioClip()");
    }
    handle._.pitch = pitch;
    if (handle._.detune) {
        // Doesn't work on Safari
        handle._.detune.linearRampToValueAtTime((pitch - 1) * 1200, _ch_audioContext.currentTime + audioRampTime);
    }
}


// Exported to Runtime
function playAudioClip(audioClip, loop, volume, pan, pitch, time) {
    if (audioClip.audioClip && (arguments.length === 1)) {
        // Object version
        loop      = audioClip.loop;
        volume    = audioClip.volume;
        pan       = audioClip.pan;
        pitch     = audioClip.pitch;
        time      = audioClip.time;
        audioClip = audioClip.audioClip;
    }

    if (! audioClip || ! audioClip.source) {
        throw new Error('playAudioClip() requires an audioClip');
    }
    
    // Ensure that the value is a boolean
    loop = loop ? true : false;
    time = time || 0;
    if (pan === undefined) { pan = 0; }
    if (pitch === undefined) { pitch = 1; }
    if (volume === undefined) { volume = 1; }

    if (audioClip.loaded) {
        return internalSoundSourcePlay({_:null}, audioClip, time * 1000, loop, volume, pitch, pan);
    } else {
        return undefined;
    }
}


// Exported to Runtime
function resumeSound(handle) {
    if (! (handle && handle._ && handle._.stop)) {
        throw new Error("stopSound() takes one argument that is the handle returned from playAudioClip()");
    }
    if (handle._.resumePositionMs) {
        // Actually paused
        internalSoundSourcePlay(handle, handle._.audioClip, handle._.resumePositionMs, handle._.loop, handle._.volume, handle._.pitch, handle._.pan);
    }
}


// Exported to Runtime
function stopSound(handle) {
    if (! (handle && handle._ && handle._.stop)) {
        throw new Error("stopSound() takes one argument that is the handle returned from playAudioClip()");
    }
    
    try {
        handle._.stop();
    } catch (e) {
        // Ignore invalid state error if loading has not succeeded yet
    }
}


function pauseAllSounds() {
    // We can't save the iterator itself because that doesn't keep the
    // sounds alive, so we store a duplicate array.
    pausedSoundHandleArray = [];
    for (let handle of activeSoundHandleMap.keys()) {
        pausedSoundHandleArray.push(handle);
        try { handle._.stop(); } catch (e) {}
    }
}


function stopAllSounds() {
    pausedSoundHandleArray = null;
    for (let handle of activeSoundHandleMap.keys()) {
        try { handle._.stop(); } catch (e) {}
    }
}


function resumeAllSounds() {
    for (let handle of pausedSoundHandleArray) {
        // Have to recreate, since no way to restart 
        internalSoundSourcePlay(handle, handle._.audioClip, handle._.resumePositionMs, handle._.loop, handle._.volume, handle._.pitch, handle._.pan);
    }
    pausedSoundHandleArray = null;
}

////////////////////////////////////////////////////////////////////////////////////

// Escapes HTML
// Injected as debugPrint in Runtime
function debugPrint(...args) {
    let s = '';
    for (let i = 0; i < args.length; ++i) {
        let m = args[i]
        if (typeof m !== 'string') { m = Runtime.unparse(m); }
        s += m;
        if (i < args.length - 1) {
            s += ' ';
        }
    }
    
    _outputAppend(escapeHTMLEntities(s) + '\n');
}


// Injected as assert in Runtime
function assert(x, m) {
    if (! x) {
        throw new Error(m || "Assertion failed");
    }
}

// Allows HTML, forces the system style
function _systemPrint(m) {
    _outputAppend('<i>' + escapeHTMLEntities(m) + '</i>\n');
}


// Allows HTML
function _outputAppend(m) {
    if (m !== '') {
        // Remove tags and then restore HTML entities
        console.log(m.replace(/<.+?>/g, '').replace(/&quot;/g,'"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'));
        outputDisplayPane.innerHTML += m;
        // Scroll to bottom
        outputDisplayPane.scrollTop = outputDisplayPane.scrollHeight - outputDisplayPane.clientHeight;
    }
}


function rgbaToCSSFillStyle(color) {
    return `rgba(${color.r*255}, ${color.g*255}, ${color.b*255}, ${color.a})`;
}


function submitFrame() {
    // Update the image
    ctx.msImageSmoothingEnabled = ctx.webkitImageSmoothingEnabled = ctx.imageSmoothingEnabled = false;

    const _postFX = Runtime._postFX;
    const hasPostFX = (_postFX.opacity < 1) || (_postFX.color.a > 0) || (_postFX.angle !== 0) ||
          (_postFX.pos.x !== 0) || (_postFX.pos.y !== 0) ||
          (_postFX.scale.x !== 1) || (_postFX.scale.y !== 1) ||
          (_postFX.blendMode !== 'source-over');

    if (previewRecording) {
        processPreviewRecording();
    }
    
    if (! hasPostFX && ! gifRecording && (emulatorScreen.width === SCREEN_WIDTH && emulatorScreen.height === SCREEN_HEIGHT)) {
        // Directly upload to the screen. Fast path for Chrome and Firefox, which support
        // image-rendering on Canvas.
        ctx.putImageData(updateImageData, 0, 0);
    } else {
        // Put on an intermediate image and then stretch. This path is for postFX and supporting Safari
        // and other platforms where context graphics can perform nearest-neighbor interpolation but CSS scaling cannot.
        const updateCTX = updateImage.getContext('2d', {alpha: false});
        updateCTX.putImageData(updateImageData, 0, 0);
        if (_postFX.color.a > 0) {
            updateCTX.fillStyle = rgbaToCSSFillStyle(_postFX.color);
            updateCTX.globalCompositeOperation = _postFX.blendMode;
            updateCTX.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        }

        ctx.save();
        if (_postFX.background.a > 0) {
            if (_postFX.background.r === 0 && _postFX.background.g === 0 && _postFX.background.b === 0 && _postFX.background.a === 0) {
                ctx.clearRect(0, 0, emulatorScreen.width, emulatorScreen.height);
            } else {
                ctx.fillStyle = rgbaToCSSFillStyle(_postFX.background);
                ctx.fillRect();
            }
        }
        ctx.globalAlpha = _postFX.opacity;
        ctx.translate((_postFX.pos.x / SCREEN_WIDTH + 0.5) * emulatorScreen.width,
                      (_postFX.pos.y / SCREEN_HEIGHT + 0.5) * emulatorScreen.height); 
        ctx.rotate(-_postFX.angle);
        ctx.scale(_postFX.scale.x, _postFX.scale.y);
        ctx.translate(-emulatorScreen.width / 2, -emulatorScreen.height / 2); 
        ctx.drawImage(updateImage,
                      0, 0, SCREEN_WIDTH, SCREEN_HEIGHT,
                      0, 0, emulatorScreen.width, emulatorScreen.height);
        ctx.restore();
    }

    if (gifRecording) {
        // Only record alternating frames to reduce file size
        if (gifRecording.frameNum & 1) {
            if (gifRecording.scale > 1) {
                // Double pixels
                gifCtx.imageSmoothingEnabled = false;
                gifCtx.drawImage(emulatorScreen,
                                 0, 0, emulatorScreen.width, emulatorScreen.height,
                                 0, 0, SCREEN_WIDTH * gifRecording.scale, SCREEN_HEIGHT * gifRecording.scale);
                gifRecording.addFrame(gifCtx, {delay: 1000/30, copy: true});
            } else {
                gifRecording.addFrame(updateImage.getContext('2d'), {delay: 1000/30, copy: true});
            }
        }
        ++gifRecording.frameNum;
        if (gifRecording.frameNum > 60 * 12) {
            // Stop after 12 seconds
            document.getElementById('recording').classList.add('hidden');
            gifRecording.render();
            gifRecording = null;
        }
    }
    
    refreshPending = true;
}


function updateInput() {
    const axes = 'xy', buttons = 'abcdpq', BUTTONS = 'ABCDPQ';

    // HTML gamepad indices of corresponding elements of the buttons array
    // A, B, C, D, P, Q
    const buttonIndex = [0, 1, 2, 3, 9, 8];
    
    // Aliases on console game controller using stick buttons
    // and trigger + shoulder buttons. These are read from 
    // pad[2] and applied to pad[0]
    const altButtonIndex = [7, 5, 6, 4, undefined, undefined];
    
    const gamepadArray = getIdealGamepads();
    
    // Sample the keys
    for (let player = 0; player < 4; ++player) {
        const map = keyMap[player], pad = Runtime.pad[player],
            realGamepad = gamepadArray[player], prevRealGamepad = prevRealGamepadState[player];

        /*
	// Used for having player 0 physical controls set player 2 virtual buttons
        // and player 1 controls set player 3 buttons. This allows two 
        // dual-stick controls. Unfortunately, it doesn't let the keyboard
        // work for 1-player dual-stick.
	const altRealGamepad = (player === 2) ? gamepadArray[0] : (player === 3) ? gamepadArray[1] : undefined,
	altPrevRealGamepad = (player === 2) ? prevRealGamepadState[0] : (player === 3) ? prevRealGamepadState[0] : undefined; */

        // Have player 0 physical alt controls set player 1 virtual buttons
	const altRealGamepad = (player === 1) ? gamepadArray[0] : undefined,
	      altPrevRealGamepad = (player === 1) ? prevRealGamepadState[0] : undefined;

        // Axes
        for (let a = 0; a < axes.length; ++a) {
            const axis = axes[a];
            const pos = '+' + axis, neg = '-' + axis;
            const old = pad[axis];
            const scale = (axis == 'x') ? Runtime._scaleX : Runtime._scaleY;

            if (map) {
                // Keyboard controls
                const n0 = map[neg][0], n1 = map[neg][1], p0 = map[pos][0], p1 = map[pos][1];

                // Current state
                pad[axis] = (((emulatorKeyState[n0] || emulatorKeyState[n1]) ? -1 : 0) +
                             ((emulatorKeyState[p0] || emulatorKeyState[p1]) ? +1 : 0)) * scale;

                // Just pressed
                pad[axis + axis] = (((emulatorKeyJustPressed[n0] || emulatorKeyJustPressed[n1]) ? -1 : 0) +
                                    ((emulatorKeyJustPressed[p0] || emulatorKeyJustPressed[p1]) ? +1 : 0)) * scale;
            } else {
                pad[axis] = pad[axis + axis] = 0;
            }

            if (realGamepad && (realGamepad.axes[a] !== 0)) { pad[axis] = realGamepad.axes[a] * scale; }
            if (realGamepad && (prevRealGamepad.axes[a] !== realGamepad.axes[a])) {
                pad[axis + axis] = realGamepad.axes[a] * scale;
            }

            if ((player === 1) && gamepadArray[0]) {
                const otherPad = gamepadArray[0];
                // Alias controller[0] right stick (axes 2 + 3) 
                // to controller[1] d-pad (axes 0 + 1) for "dual stick" controls                
                if (otherPad.axes[a + 2] !== 0) {
                    pad[axis] = otherPad.axes[a + 2] * scale;
                }
                if (otherPad.axes[a + 2] !== otherPad.axes[a + 2]) {
                    pad[axis + axis] = otherPad.axes[a + 2] * scale;
                }
            } // dual-stick


            pad['d' + axis] = pad[axis] - old;
        }

        for (let b = 0; b < buttons.length; ++b) {
            const button = buttons[b], BUTTON = BUTTONS[b];

            if (map) {
                // Keyboard
                const b0 = map[button][0], b1 = map[button][1];
                pad[button] = (emulatorKeyState[b0] || emulatorKeyState[b1]) ? 1 : 0;
                pad[button + button] = pad['pressed' + BUTTON] = (emulatorKeyJustPressed[b0] || emulatorKeyJustPressed[b1]) ? 1 : 0;
                pad['released' + BUTTON] = (emulatorKeyJustReleased[b0] || emulatorKeyJustReleased[b1]) ? 1 : 0;
            } else {
                pad[button] = pad[button + button] = pad['released' + BUTTON] = pad['pressed' + BUTTON] = 0;
            }

            const i = buttonIndex[b], j = altButtonIndex[b];
            const isPressed  = (realGamepad && realGamepad.buttons[i]) || (altRealGamepad && altRealGamepad.buttons[j]);
	    
	    const wasPressed = (prevRealGamepad && prevRealGamepad.buttons[i]) ||
		               (altPrevRealGamepad && altPrevRealGamepad.buttons[j]);
	    
            if (isPressed) { pad[button] = 1; }
	    
            if (isPressed && ! wasPressed) {
                pad[button + button] = 1;
                pad['pressed' + BUTTON] = 1;
            }

            if (! isPressed && wasPressed) {
                pad['released' + BUTTON] = 1;
            }
        }

        if ((pad.y != 0) || (pad.x != 0)) {
            pad.angle = Math.atan2(pad.y, pad.x);
        }

        if ((pad.y + pad.dy == 0 && pad.x + pad.dx == 0) || (pad.y == 0 && pad.x == 0)) {
            pad.dangle = 0;
        } else {
            const newAngle = Math.atan2(pad.y + pad.dy, pad.x + pad.dx);
            // JavaScript operator % is a floating-point operation
            pad.dangle = ((3 * Math.PI + Runtime.pad.angle - newAngle) % (2 * Math.PI)) - Math.PI;
        }
    }
    
    // Update previous state. This has to be done AFTER the above
    // loop so that the alternative buttons for player 2 are not
    // immediately overrident during player 1's processing.
    for (let player = 0; player < 4; ++player) {
	if (gamepadArray[player]) {
            prevRealGamepadState[player] = gamepadArray[player];
	}
    }

    // Reset the just-pressed state
    emulatorKeyJustPressed = {};
    emulatorKeyJustReleased = {};
}

////////////////////////////////////////////////////////////////////////////////////////////
//
// Mobile button support
//
//
// Because a touch end for *one* finger could occur for an element
// that still has another finger holding it down, we have to track
// all active touches and synthesize events for them rather than
// simply execute the mouse handlers directly. We also can't allow
// the mouse handers to *automatically* fire, since they run at a
// 300 ms delay on mobile.

// For use when processing buttons
const emulatorButtonArray = Array.from(document.getElementsByClassName('emulatorButton'));
const deadZoneArray = Array.from(document.getElementsByClassName('deadZone'));

// Maps touch.identifiers to objects with x and y members
const activeTouchTracker = {};

/* event must have clientX and clientY */
function inElement(event, element) {
    const rect = element.getBoundingClientRect();
    if (element.style.transform === 'rotate(45deg)') {
        // Assume symmetrical
        const centerX = rect.left + rect.width * 0.5;
        const centerY = rect.top + rect.height * 0.5;
        return Math.abs(centerX - event.clientX) + Math.abs(centerY - event.clientY) < rect.width * 0.5;
    } else {
        return (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    }
}

function onTouchStartOrMove(event) {
    for (let i = 0; i < event.changedTouches.length; ++i) {
        const touch = event.changedTouches[i];
        let tracker = activeTouchTracker[touch.identifier];

        if (! tracker) {
            tracker = activeTouchTracker[touch.identifier] = {identifier: touch.identifier};
        }
        
        tracker.clientX = touch.clientX;
        tracker.clientY = touch.clientY;
    }

    onTouchesChanged(event);
    return false;
}


function onTouchEndOrCancel(event) {
    // Add the new touches
    for (let i = 0; i < event.changedTouches.length; ++i) {
        let touch = event.changedTouches[i];
        let tracker = activeTouchTracker[touch.identifier];
        // The tracker *should* be found, but check defensively
        // against weird event delivery
        if (tracker) {
            // Delete is relatively slow (https://jsperf.com/delete-vs-undefined-vs-null/16),
            // but there are far more move events than end events and the table is more
            // convenient and faster for processing move events than an array.
            delete activeTouchTracker[touch.identifier];            
        }
    }
    
    onTouchesChanged(event);
    return false;
}

/* Processes all emulatorButtons against the activeTouchTracker. If
   any *changed* touch was currently over a button, cancels the event. */
function onTouchesChanged(event) {
    // Latch state
    for (let j = 0; j < emulatorButtonArray.length; ++j) {
        const button = emulatorButtonArray[j];
        button.wasPressed = button.currentlyPressed || false;
        button.currentlyPressed = false;
    }
    
    // Processes all touches to see what is currently pressed
    for (let t in activeTouchTracker) {
        const touch = activeTouchTracker[t];
        let touchPressed = true;

        // Test against dead zone
        for (let j = 0; j < deadZoneArray.length; ++j) {
            if (inElement(touch, deadZoneArray[j])) {
                touchPressed = false;
                break;
            }
        }

        // Process all buttons
        for (let j = 0; j < emulatorButtonArray.length; ++j) {
            const button = emulatorButtonArray[j];
            button.currentlyPressed = button.currentlyPressed ||
                (inElement(touch, button) && touchPressed);
        }
    }

    // Now see which buttons differ from their previous state
    for (let j = 0; j < emulatorButtonArray.length; ++j) {
        const button = emulatorButtonArray[j];
        if (button.wasPressed !== button.currentlyPressed) {
            // This button's state changed
            const buttonKey = button.id[0];

            // Fake a keyboard event
            const fakeEvent = {keyCode:ascii(buttonKey), stopPropagation:Math.abs, preventDefault:Math.abs}
            
            if (button.currentlyPressed) {
                onEmulatorKeyDown(fakeEvent);
                emulatorButtonState[buttonKey] = 1;
            } else {
                onEmulatorKeyUp(fakeEvent);
                emulatorButtonState[buttonKey] = 0;
            }
        }
    }

    // See if this event was in any of the buttons (including on and
    // end event, where it will not be in the touch list) and then
    // prevent/stop that event so that we don't get a synthetic mouse event
    // or scroll.
    for (let i = 0; i < event.changedTouches.length; ++i) {
        let touch = event.changedTouches[i];
        for (let j = 0; j < emulatorButtonArray.length; ++j) {
            if (inElement(touch, emulatorButtonArray[j])) {
                event.preventDefault();
                event.stopPropagation();
                break;
            }
        }
    }
}


const fakeMouseEvent = {
    changedTouches: [{identifier:-1, clientX: 0, clientY:0}],
    realEvent: null,
    preventDefault: function() { this.realEvent.preventDefault(); },
    stopPropagation: function() { this.realEvent.stopPropagation(); },
};

function onMouseDownOrMove(event) {
    if (event.buttons !== 0) {
        // Synthesize a fake touch event (which will then get turned
        // into a fake key event!)
        fakeMouseEvent.changedTouches[0].clientX = event.clientX;
        fakeMouseEvent.changedTouches[0].clientY = event.clientY;
        fakeMouseEvent.realEvent = event;
        onTouchStartOrMove(fakeMouseEvent);
    }
}


function onMouseUpOrMove(event) {
    // Synthesize a fake touch event (which will then get turned
    // into a fake key event!)
    fakeMouseEvent.changedTouches[0].clientX = event.clientX;
    fakeMouseEvent.changedTouches[0].clientY = event.clientY;
    fakeMouseEvent.realEvent = event;
    onTouchEndOrCancel(fakeMouseEvent);
}


document.addEventListener('mousedown',   onMouseDownOrMove);
document.addEventListener('mousemove',   onMouseDownOrMove);
document.addEventListener('mouseup',     onMouseUpOrMove);
document.addEventListener('touchstart',  onTouchStartOrMove);
document.addEventListener('touchmove',   onTouchStartOrMove);
document.addEventListener('touchend',    onTouchEndOrCancel);
document.addEventListener('touchcancel', onTouchEndOrCancel);


