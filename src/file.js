import $ from "jquery";
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

import * as state from "./state.js";
import * as actions from "./actions.js";

// TODO HACK Had to override gif.js, background option wasn't working.
//           Fix background: https://github.com/jnordberg/gif.js/pull/46
//           Fix typo: https://github.com/jnordberg/gif.js/pull/74
//           Fix transparency: https://github.com/jnordberg/gif.js/pull
//              - This didn't seem to work no matter what I tried
// import GIF from 'gif.js.optimized/dist/gif.js';
import GIF from './vendor/gif.cjs';

import {confirmDialog, createDialog, createHTMLFile, createHorizontalMenu, isFunction} from "./utilities.js";
import {CanvasControl} from "./canvas.js";
import Color from "@sphinxxxx/color-conversion";
import {fontRatio} from "./fonts.js";

const FILE_EXTENSION = 'ascii'; // TODO Think of a file extension to use


export function init() {
    setupMainMenu();
    setupNewFile();
    setupUpload();
    setupSaveDialog();
    setupExportDialog();
}



// --------------------------------------------------------------- Main Menu

let $mainMenu, mainMenu;

function setupMainMenu() {
    $mainMenu = $('#main-menu');
    mainMenu = createHorizontalMenu($mainMenu, $li => refreshMenu());
}

export function refreshMenu() {
    if (mainMenu.isShowing()) {
        $mainMenu.find('.action-item').each((index, item) => {
            const $item = $(item);
            const action = actions.getActionInfo($item.data('action'));

            if (action) {
                let html = `<span>${action.name}</span>`;
                if (action.shortcutAbbr) {
                    html += `<span class="shortcut">${action.shortcutAbbr}</span>`;
                }
                $item.html(html);
                $item.off('click').on('click', () => action.callback());
                $item.toggleClass('disabled', !action.enabled);
            }
            else {
                $item.empty();
                $item.off('click');
            }
        });
    }
}


// --------------------------------------------------------------- New File

function setupNewFile() {
    actions.registerAction('file.new-file', () => {
        // TODO ask for dimensions, etc.
        confirmDialog('Create new animation?', 'Any unsaved changes will be lost.', () => state.loadNew());
    });
}

// --------------------------------------------------------------- Uploading

function setupUpload() {
    const $uploadInput = $('#upload-file');
    $uploadInput.attr('accept', `.${FILE_EXTENSION}`);

    $uploadInput.off('change').on('change', function(evt) {
        const file = evt.target.files[0];
        $uploadInput.val(null); // null out <input> so if the user uploads same file it gets refreshed

        if (file) {
            const reader = new FileReader();

            reader.addEventListener("load", function() {
                try {
                    state.load(JSON.parse(reader.result));
                }
                catch (exception) {
                    console.error(exception.message, exception.stack);
                    alert(exception.message + '\n\nView browser console for full stack trace.');
                }
            }, false);

            reader.readAsText(file);
        }
    });

    actions.registerAction('file.open-file', () => {
        // Doing asynchronously so main menu has time to close
        window.setTimeout(() => $uploadInput.trigger('click'), 1);
    });
}


// --------------------------------------------------------------- Saving
let $saveFileDialog;

function setupSaveDialog() {
    $saveFileDialog = $('#save-file-dialog');

    createDialog($saveFileDialog, () => {
        state.config('name', $saveFileDialog.find('.name').val());
        const blob = new Blob([state.stringify()], {type: "text/plain;charset=utf-8"});
        saveAs(blob, `${state.config('name')}.${FILE_EXTENSION}`)
        $saveFileDialog.dialog('close');
    });

    actions.registerAction('file.save-file', () => openSaveDialog());
}

function openSaveDialog() {
    $saveFileDialog.find('.name').val(state.config('name'));
    $saveFileDialog.find('.extension').html(`.${FILE_EXTENSION}`);
    $saveFileDialog.dialog('open');
}




// --------------------------------------------------------------- Export

const DEFAULT_FONT_SIZE = 16;

const EXPORT_OPTIONS = {
    png: ['width', 'height', 'background', 'frames', 'spritesheetColumns', 'spritesheetRows'],
    txt: ['frames', 'frameSeparator'],
    rtf: ['fontSize', 'background', 'frames', 'frameSeparator'],
    html: ['fontSize', 'fps', 'background', 'loop'],
    gif: ['width', 'height', 'fps', 'background', 'loop'],
}

// The following options are visible only if 'frames' is set to the given value
const EXPORT_FRAMES_DEPENDENCIES = {
    spritesheetColumns: 'spritesheet',
    spritesheetRows: 'spritesheet',
    frameSeparator: 'spritesheet'
}

const EXPORT_OPTION_VALIDATORS = {
    fontSize: { type: 'float' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    fps: { type: 'integer' }, // todo if > 1
    spritesheetColumns: { type: 'integer' },
    spritesheetRows: { type: 'integer' }
}

let $exportFileDialog, $exportFormat, $exportOptions;
let $exportCanvasContainer, exportCanvas;

function setupExportDialog() {
    $exportFileDialog = $('#export-file-dialog');
    $exportFormat = $exportFileDialog.find('#export-file-format');
    $exportOptions = $exportFileDialog.find('#export-options');
    $exportCanvasContainer = $('#export-canvas-container');
    exportCanvas = new CanvasControl($('#export-canvas'), {});

    createDialog($exportFileDialog, () => {
        exportFile(() => {
            $exportFileDialog.dialog('close');
        });
    }, 'Export', {
        minWidth: 500,
        maxWidth: 500,
        minHeight: 500,
        maxHeight: 500
    });

    $exportFormat.on('change', evt => {
        const format = $(evt.currentTarget).val();
        $exportOptions.find('label').hide();

        EXPORT_OPTIONS[format].forEach(option => {
            $exportOptions.find(`[name="${option}"]`).closest('label').show();
        });

        $exportOptions.find('[name="frames"]').trigger('change');
    });

    $exportOptions.find('[name="frames"]').on('change', evt => {
        const framesValue = $(evt.currentTarget).val();
        for (let [option, dependency] of Object.entries(EXPORT_FRAMES_DEPENDENCIES)) {
            $exportOptions.find(`[name="${option}"]`).closest('label').toggle(
                EXPORT_OPTIONS[$exportFormat.val()].includes(option) && framesValue === dependency
            );
        }
    });

    $exportOptions.find('[name="width"]').on('input', evt => {
        const width = $(evt.currentTarget).val();
        const height = Math.round(width / state.numCols() * state.numRows() / fontRatio);
        $exportOptions.find('[name="height"]').val(height);
    });
    $exportOptions.find('[name="height"]').on('input', evt => {
        const height = $(evt.currentTarget).val();
        const width = Math.round(height / state.numRows() * state.numCols() * fontRatio);
        $exportOptions.find('[name="width"]').val(width);
    });

    actions.registerAction('file.export-file', () => openExportDialog());
}


function openExportDialog() {
    $exportFileDialog.dialog('open');

    $exportOptions.find(`[name="fps"]`).val(state.config('fps'));

    const $width = $exportOptions.find(`[name="width"]`);
    if (!$width.val()) {
        $width.val(state.numCols() * DEFAULT_FONT_SIZE).trigger('input');
    }

    const $fontSize = $exportOptions.find(`[name="fontSize"]`);
    if (!$fontSize.val()) {
        $fontSize.val(DEFAULT_FONT_SIZE);
    }

    $exportFormat.trigger('change');
}

// Resets the export width input, so that the next time the export dialog is opened it recalculates good defaults
// for exported width/height
export function resetExportDimensions() {
    $exportOptions.find(`[name="width"]`).val('');
}

function exportFile(onSuccess) {
    const { isValid, options } = validateExportOptions();

    if (!isValid) {
        return;
    }

    switch($exportFormat.val()) {
        case 'png':
            exportPng(options);
            break;
        case 'txt':
            exportTxt(options);
            break;
        case 'rtf':
            exportRtf(options);
            break;
        case 'html':
            exportHtml(options);
            break;
        case 'gif':
            exportGif(options);
            break;
        default:
            console.warn(`Invalid export format: ${options.format}`);
    }

    onSuccess();
}

function validateExportOptions() {
    $exportOptions.find('.error').removeClass('error');

    let options = {};
    let isValid = true;

    EXPORT_OPTIONS[$exportFormat.val()].forEach(option => {
        // Special case: skip option if it is dependent on a different 'frames' value
        if (EXPORT_FRAMES_DEPENDENCIES[option] !== undefined) {
            const framesValue = $exportOptions.find(`[name="frames"]`).val();
            if (EXPORT_FRAMES_DEPENDENCIES[option] !== framesValue) {
                return;
            }
        }

        const $input = $exportOptions.find(`[name="${option}"]`);
        let value = $input.val();
        if ($input.is(':checkbox')) {
            value = $input.is(':checked');
        }

        if (EXPORT_OPTION_VALIDATORS[option]) {
            switch(EXPORT_OPTION_VALIDATORS[option].type) {
                case 'integer':
                    value = parseInt(value);
                    if (isNaN(value)) {
                        $input.addClass('error');
                        isValid = false;
                    }
                    break;
                case 'float':
                    value = parseFloat(value);
                    if (isNaN(value)) {
                        $input.addClass('error');
                        isValid = false;
                    }
                    break;
                default:
                    console.warn(`No validator found for: ${EXPORT_OPTION_VALIDATORS[option].type}`);
            }
        }

        options[option] = value;
    });

    return {
        isValid: isValid,
        options: options
    };
}

/**
 * options:
 *  - frames: ['current', 'zip', 'spritesheet']
 *  - frameSeparator: (only applicable if frames:spritesheet) characters to separate frames with
 */
function exportTxt(options = {}) {
    let txt, blob;

    function _frameToTxt(frame) {
        return exportableFrameString(frame, '\n');
    }

    switch(options.frames) {
        case 'zip':
            const zip = new JSZip();
            state.frames().forEach((frame, index) => {
                zip.file(`${index}.txt`, _frameToTxt(frame));
            });
            zip.generateAsync({type:"blob"}).then(function(content) {
                saveAs(content, `${state.config('name')}.zip`);
            });
            break;
        case 'current':
            txt = _frameToTxt(state.currentFrame());
            blob = new Blob([txt], {type: "text/plain;charset=utf-8"});
            saveAs(blob, `${state.config('name')}.txt`);
            break;
        case 'spritesheet':
            txt = '';
            state.frames().forEach((frame, index) => {
                txt += buildFrameSeparator(options, index, '\n');
                txt += _frameToTxt(frame);
            });
            blob = new Blob([txt], {type: "text/plain;charset=utf-8"});
            saveAs(blob, `${state.config('name')}.txt`);
            break;
        default:
            console.error(`Invalid options.frames: ${options.frames}`);
    }
}

/**
 * options:
 *  - fontSize: font size
 *  - frames: ['current', 'zip', 'spritesheet']
 *  - frameSeparator: (only applicable if frames:spritesheet) character to separate frames with
 *
 * For more information on RTF format: https://www.oreilly.com/library/view/rtf-pocket-guide/9781449302047/ch01.html
 */
function exportRtf(options) {
    let rtf, blob;

    const rtfColors = [
        // First color (black) reserved for frameSeparators
        encodeColor('rgba(0,0,0,1)'),

        // Second color reserved for background
        encodeColor(state.config('background') ? state.config('background') : 'rgba(0,0,0,1)'),

        // Then merge in all colors used in the drawing
        ...state.colorTable().map(colorStr => encodeColor(colorStr))
    ]

    // char background: use index 1 of color table. Note: chshdng / chcbpat is for MS Word compatibility
    const cb = options.background && state.config('background') ? `\\chshdng0\\chcbpat${1}\\cb${1}` : '';

    function encodeColor(colorStr) {
        const [r, g, b, a] = new Color(colorStr).rgba; // Break colorStr into rgba components
        return `\\red${r}\\green${g}\\blue${b}`; // Note: alpha cannot be shown in rtf
    }

    function _buildRtfFile(content) {
        // fmodern tells the OS to use a monospace font in case the given font is not found
        const fontTable = `{\\fonttbl {\\f0\\fmodern ${state.config('font')};}}`;

        const colorTable = `{\\colortbl ${rtfColors.join(';')};}`;

        // rtf font size is in half pt, so multiply desired font size by 2
        const fontSize = options.fontSize * 2;

        return `{\\rtf1\\ansi\\deff0 ${fontTable}${colorTable}\\f0\\fs${fontSize} ${content}}`;
    }

    function _frameToRtf(frame) {
        return exportableFrameString(frame, '\\line ', line => {
            // First replace handles special RTF chars: { } \
            // The other 3 replace calls handle escaping unicode chars (see oreilly doc above for more info)
            const escapedText = line.text
                .replace(/[{}\\]/g, match => "\\" + match) // Escape special RTF chars: { } \
                .replace(/[\u0080-\u00FF]/g, match => `\\'${match.charCodeAt(0).toString(16)}`)
                .replace(/[\u0100-\u7FFF]/g, match => `\\uc1\\u${match.charCodeAt(0)}*`)
                .replace(/[\u8000-\uFFFF]/g, match => `\\uc1\\u${match.charCodeAt(0)-0xFFFF}*`)

            // For foreground color, add 2 to colorIndex since we prepended 2 colors to the color table
            return `{\\cf${line.colorIndex + 2}${cb} ${escapedText}}`;
        })
    }

    switch(options.frames) {
        case 'zip':
            const zip = new JSZip();
            state.frames().forEach((frame, index) => {
                zip.file(`${index}.rtf`, _buildRtfFile(_frameToRtf(frame)));
            });
            zip.generateAsync({type:"blob"}).then(function(content) {
                saveAs(content, `${state.config('name')}.zip`);
            });
            break;
        case 'current':
            rtf = _buildRtfFile(_frameToRtf(state.currentFrame()));
            blob = new Blob([rtf], {type: "text/plain;charset=utf-8"});
            saveAs(blob, `${state.config('name')}.rtf`);
            break;
        case 'spritesheet':
            rtf = '';
            state.frames().forEach((frame, index) => {
                rtf += `{\\cf0 ${buildFrameSeparator(options, index, '\\line ')}}`; // use index 0 of color table
                rtf += _frameToRtf(frame);
            });
            rtf = _buildRtfFile(rtf);
            blob = new Blob([rtf], {type: "text/plain;charset=utf-8"});
            saveAs(blob, `${state.config('name')}.rtf`);
            break;
        default:
            console.error(`Invalid options.frames: ${options.frames}`);
    }
}

/**
 * options:
 *  - fontSize: font size
 *  - fps: frames per second
 *  - background: (boolean) whether to include background or not TODO
 *  - loop: (boolean) whether to loop the animation continuously
 */
function exportHtml(options) {
    const frames = state.frames().map(frame => {
        return exportableFrameString(frame, '<br>', line => `<span style="color:${state.colorStr(line.colorIndex)};">${line.text}</span>`)
    });

    // <script> that will animate the <pre> contents
    const script = `
        document.addEventListener("DOMContentLoaded", function() {
            var sprite = document.getElementById('sprite');
            var frames = ${JSON.stringify(frames)};
            var fps = ${frames.length > 1 ? options.fps : 0};
            var loop = ${options.loop};
            var frameIndex = 0;

            function draw() {
                sprite.innerHTML = frames[frameIndex];
                frameIndex++;
                if (frameIndex >= frames.length) { 
                    frameIndex = 0;
                }
                if (fps !== 0 && (loop || frameIndex !== 0)) { 
                    setTimeout(draw, 1000 / fps); 
                }
            }
            
            draw();
        });
    `;

    const width = state.numCols() * options.fontSize * fontRatio;
    const background = options.background && state.config('background') ? `background: ${state.config('background')};` : '';
    const fontStyles = `font-family: ${state.fontFamily()};font-size: ${options.fontSize}px;`;

    const body = `<pre id="sprite" style="width:${width}px;${background};${fontStyles}"></pre>`;
    const html = createHTMLFile(state.config('name'), script, body);
    const blob = new Blob([html], {type: "text/plain;charset=utf-8"});
    saveAs(blob, `${state.config('name')}.html`);
}

/**
 * options:
 *  - width: width of result
 *  - height: height of result
 *  - fps: frames per second
 *  - background: (boolean) whether to include background or not TODO
 *  - loop: (boolean) whether to loop the animation continuously
 *
 * TODO Limitations: Does not work with alpha. #000000 does not work, have to change to #010101
 */
function exportGif(options) {
    const width = options.width;
    const height = options.height;
    const fps = options.fps;

    $exportCanvasContainer.toggleClass('is-exporting', true)
        .width(width / window.devicePixelRatio)
        .height(height / window.devicePixelRatio);

    exportCanvas.resize();
    exportCanvas.zoomToFit();

    const gif = new GIF({
        // debug: true,
        width: width,
        height: height,
        repeat: options.loop ? 0 : -1,
        background: 'rgba(0,0,0,0)',
        transparent: 'rgba(0,0,0,0)',
        workers: 5,
        quality: 5,
        // workerScript: new URL('gif.js.optimized/dist/gif.worker.js', import.meta.url)
        workerScript: new URL('./vendor/gif.worker.cjs', import.meta.url)
    });

    state.frames().forEach(frame => {
        exportCanvas.clear();
        if (options.background && state.config('background')) {
            exportCanvas.drawBackground(state.config('background'));
        }
        exportCanvas.drawGlyphs(state.layeredGlyphs(frame, { showAllLayers: true }));
        // gif.addFrame(exportCanvas.canvas, { delay: 1000 / fps }); // doesn't work with multiple frames
        gif.addFrame(exportCanvas.context, {copy: true, delay: 1000 / fps });
    });

    gif.on('finished', function(blob) {
        // window.open(URL.createObjectURL(blob));
        saveAs(blob, `${state.config('name')}.gif`);
    });

    gif.render();
}

/**
 * options:
 *  - width: width of result
 *  - height: height of result
 *  - frames: ['current', 'zip', 'spritesheet']
 *  - spritesheetColumns: # of columns in the spritesheet todo
 *  - spritesheetRows: # of rows in the spritesheet todo
 */
function exportPng(options) {
    const width = options.width;
    const height = options.height;

    $exportCanvasContainer.toggleClass('is-exporting', true)
        .width(width / window.devicePixelRatio)
        .height(height / window.devicePixelRatio);

    exportCanvas.resize();
    exportCanvas.zoomToFit();

    function _frameToPng(frame, callback) {
        exportCanvas.clear();
        if (options.background && state.config('background')) {
            exportCanvas.drawBackground(state.config('background'));
        }
        exportCanvas.drawGlyphs(state.layeredGlyphs(frame, { showAllLayers: true }));
        exportCanvas.canvas.toBlob(function(blob) {
            callback(blob);
        });
    }

    function complete() {
        $exportCanvasContainer.toggleClass('is-exporting', false);
    }

    switch(options.frames) {
        case 'zip':
            const zip = new JSZip();

            // Build the zip file using callbacks since canvas.toBlob is asynchronous
            function addFrameToZip(index) {
                if (index <= state.frames().length - 1) {
                    _frameToPng(state.frames()[index], blob => {
                        zip.file(`${index}.png`, blob);
                        addFrameToZip(index + 1);
                    });
                }
                else {
                    // Finished adding all frames; save the zip file
                    zip.generateAsync({type:"blob"}).then(function(content) {
                        saveAs(content, `${state.config('name')}.zip`);
                        complete();
                    });
                }
            }
            addFrameToZip(0);
            break;
        case 'current':
            _frameToPng(state.currentFrame(), blob => {
                saveAs(blob, `${state.config('name')}.png`);
                complete();
            });
            break;
        case 'spritesheet':
            // TODO implement this
            console.error('not yet implemented');
            break;
        default:
            console.error(`Invalid options.frames: ${options.frames}`);
    }
}

// Converts a frame to a string using the given newLineChar and (optional) lineFormatter
function exportableFrameString(frame, newLineChar, lineFormatter = function(line) { return line.text; }) {
    let image = '';

    const glyphs = state.layeredGlyphs(frame, { showAllLayers: true });
    let row, col, rowLength = glyphs.chars.length, colLength = glyphs.chars[0].length;

    for (row = 0; row < rowLength; row++) {
        // Convert individual chars into lines of text (of matching color), so we can draw as few <span> as possible
        let lines = [];
        let line, colorIndex;

        for (col = 0; col < colLength; col++) {
            colorIndex = glyphs.colors[row][col];

            if (line && colorIndex !== line.colorIndex) {
                // New color; have to make new line
                lines.push(line);
                line = null;
            }
            if (!line) {
                line = { colorIndex: colorIndex, text: '' }
            }
            line.text += (glyphs.chars[row][col] === '' ? ' ' : glyphs.chars[row][col]);
        }

        if (line) { lines.push(line); }

        lines.forEach(line => image += lineFormatter(line));

        image += newLineChar;
    }

    return image;
}


function buildFrameSeparator(options, index, newLineChar) {
    let char;
    let numbered = false;

    switch(options.frameSeparator) {
        case 'none':
            return '';
        case 'space':
            char = ' ';
            break;
        case 'spaceNumbered':
            char = ' ';
            numbered = true;
            break;
        case 'dash':
            char = '-';
            break;
        case 'dashNumbered':
            char = '-';
            numbered = true;
            break;
        case 'asterisk':
            char = '*';
            break;
        case 'asteriskNumbered':
            char = '*';
            numbered = true;
            break;
        default:
            console.warn(`Invalid frameSeparator: ${options.frameSeparator}`);
            return '';
    }

    return numbered ? index.toString() + char.repeat(state.numCols() - index.toString().length) + newLineChar :
        char.repeat(state.numCols()) + newLineChar;
}