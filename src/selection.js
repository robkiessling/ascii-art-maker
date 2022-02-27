import $ from "jquery";
import {frame, numRows, numCols} from './index.js';
import {refreshSelection} from "./canvas.js";

let selections = [];

export function hasSelection() {
    return selections.length > 0;
}

export function bindCanvas($canvas) {
    let isSelecting = false;

    $canvas.off('mousedown.selection', '.cell').on('mousedown.selection', '.cell', function(evt) {
        isSelecting = true;
        const $cell = $(this);

        if (!evt.metaKey && !evt.ctrlKey && !evt.shiftKey) {
            clearSelections();
        }

        if (evt.metaKey || evt.ctrlKey || !latestSelection()) {
            startSelection($cell.data('row'), $cell.data('col'));
        }

        if (evt.shiftKey) {
            latestSelection().end = { row: $cell.data('row'), col: $cell.data('col') };
            refreshSelection();
        }
    }).off('mousemove.selection', '.cell').on('mousemove.selection', '.cell', function(evt) {
        if (isSelecting) {
            const $cell = $(this);
            latestSelection().end = { row: $cell.data('row'), col: $cell.data('col') };
            refreshSelection();
        }
    });

    $(document).off('mouseup.selection').on('mouseup.selection', function(evt) {
        if (isSelecting) {
            isSelecting = false;
            refreshSelection();
        }
    });
}

/**
 * Returns a 2d array of the smallest rectangle that bounds all selections. This 2d array will contain null cells
 * if there are gaps in the rectangle.
 *
 * E.g. If the selections (depicted by x's) were this:
 *
 *        .......
 *        ..xx...
 *        ..xx..x
 *        .......
 *
 *      Returns:
 *
 *        [
 *          [x, x, null, null, null],
 *          [x, x, null, null, x]
 *        ]
 *
 * By default, values are frame chars (frame[r][c]). Can pass a @processor parameter to store a custom value.
 */
export function getSelection(processor = function(r, c) { return frame[r][c]; }) {
    if (!hasSelection()) {
        return [[]];
    }

    let layout = [];

    // Find outermost boundaries for the layout
    let { topLeft: layoutTopLeft, bottomRight: layoutBottomRight } = getSelectionCorners();

    // Fill layout with nulls
    cornerToCorner(layoutTopLeft, layoutBottomRight, (r, c) => {
        if (!layout[r - layoutTopLeft.row]) { layout[r - layoutTopLeft.row] = []; }
        layout[r - layoutTopLeft.row][c - layoutTopLeft.col] = null;
    });

    // Iterate through selections, populating layout with cell values
    selections.forEach(selection => {
        const { topLeft, bottomRight } = getCorners(selection);
        cornerToCorner(topLeft, bottomRight, (r, c) => {
            // r is absolute row; r - layoutTopLeft.row is relative row
            layout[r - layoutTopLeft.row][c - layoutTopLeft.col] = processor(r, c);
        })
    });

    return layout;
}

/**
 * Returns a flat array of coordinates for all selected cells.
 *
 * E.g. If the selections (depicted by x's) were this:
 *
 *        .......
 *        ..xx...
 *        ..xx..x
 *        .......
 *
 *      Returns:
 *
 *        [{row:1,col:2}, {row:1,col:3}, {row:2,col:2}, {row:2,col:3}, {row:2,col:6}]
 */
export function getSelectedCoordinates() {
    return getSelection((r, c) => {
        return { row: r, col: c };
    }).flat().filter(cell => cell !== null);
}

/**
 * Returns top-left and bottom-right coordinates for the smallest rectangle that includes all selections.
 *
 * E.g. If the selections (depicted by x's) were this:
 *
 *        .......
 *        ..xx...
 *        ..xx..x
 *        .......
 *
 *      Returns:
 *
 *        { topLeft: {row:1,col:2}, bottomRight: {row:2,col:6} }
 *
 */
export function getSelectionCorners() {
    let layoutTopLeft = { row: null, col: null };
    let layoutBottomRight = { row: null, col: null };
    selections.forEach(selection => {
        const { topLeft, bottomRight } = getCorners(selection);
        if (layoutTopLeft.row === null || topLeft.row < layoutTopLeft.row) { layoutTopLeft.row = topLeft.row; }
        if (layoutTopLeft.col === null || topLeft.col < layoutTopLeft.col) { layoutTopLeft.col = topLeft.col; }
        if (layoutBottomRight.row === null || bottomRight.row > layoutBottomRight.row) { layoutBottomRight.row = bottomRight.row; }
        if (layoutBottomRight.col === null || bottomRight.col > layoutBottomRight.col) { layoutBottomRight.col = bottomRight.col; }
    });
    return {
        topLeft: layoutTopLeft,
        bottomRight: layoutBottomRight
    };
}

function getCorners(selection) {
    return {
        topLeft: {
            row: Math.min(selection.start.row, selection.end.row),
            col: Math.min(selection.start.col, selection.end.col)
        },
        bottomRight: {
            row: Math.max(selection.start.row, selection.end.row),
            col: Math.max(selection.start.col, selection.end.col)
        }
    }
}

function cornerToCorner(topLeft, bottomRight, callback) {
    for (let r = topLeft.row; r <= bottomRight.row; r++) {
        for (let c = topLeft.col; c <= bottomRight.col; c++) {
            callback(r, c);
        }
    }
}

function latestSelection() {
    return selections[selections.length - 1];
}

function clearSelections() {
    selections = [];
    refreshSelection();
}

function startSelection(row, col) {
    selections.push({
        start: { row: row, col: col },
        end: { row: row, col: col }
    });
    refreshSelection();
}

function selectAll() {
    selections = [{
        start: { row: 0, col: 0 },
        end: { row: numRows() - 1, col: numCols() - 1 }
    }];
    refreshSelection();
}

// Move all selections in a particular direction, as long as they can ALL move in that direction without hitting boundaries
function moveSelections(direction, moveStart = true, moveEnd = true) {
    if (!hasSelection()) {
        startSelection(0, 0);
        return;
    }

    if (selections.every(selection => canMoveSelection(selection, direction, moveStart, moveEnd))) {
        selections.forEach(selection => moveSelection(selection, direction, moveStart, moveEnd));
    }

    refreshSelection();
}

function canMoveSelection(selection, direction, moveStart = true, moveEnd = true) {
    switch(direction) {
        case 'left':
            if (moveStart && selection.start.col <= 0) { return false; }
            if (moveEnd && selection.end.col <= 0) { return false; }
            break;
        case 'up':
            if (moveStart && selection.start.row <= 0) { return false; }
            if (moveEnd && selection.end.row <= 0) { return false; }
            break;
        case 'right':
            if (moveStart && selection.start.col >= numCols() - 1) { return false; }
            if (moveEnd && selection.end.col >= numCols() - 1) { return false; }
            break;
        case 'down':
            if (moveStart && selection.start.row >= numRows() - 1) { return false; }
            if (moveEnd && selection.end.row >= numRows() - 1) { return false; }
            break;
        default:
            console.warn(`Invalid moveSelection direction: ${direction}`);
            return false;
    }
    return true;
}

// Move a selection in a direction. Does not respect boundaries (you should call canMoveSelection first)
function moveSelection(selection, direction, moveStart = true, moveEnd = true) {
    switch(direction) {
        case 'left':
            if (moveStart) { selection.start.col -= 1; }
            if (moveEnd) { selection.end.col -= 1; }
            break;
        case 'up':
            if (moveStart) { selection.start.row -= 1; }
            if (moveEnd) { selection.end.row -= 1; }
            break;
        case 'right':
            if (moveStart) { selection.start.col += 1; }
            if (moveEnd) { selection.end.col += 1; }
            break;
        case 'down':
            if (moveStart) { selection.start.row += 1; }
            if (moveEnd) { selection.end.row += 1; }
            break;
        default:
            console.warn(`Invalid moveSelection direction: ${direction}`);
    }
}

$(document).keydown(function(e) {
    // e.ctrlKey e.altKey e.shiftKey e.metaKey (command/windows)

    const code = e.which // Keycodes https://keycode.info/ e.g. 37 38
    const char = e.key; // The resulting character: e.g. a A 1 ? Control Alt Shift Meta Enter

    // Commands
    if (e.metaKey || e.ctrlKey) {
        switch (char) {
            case 'a':
                selectAll();
                break;
            default:
                return;
        }

        e.preventDefault(); // One of the commands was used, prevent default
        return;
    }

    switch (char) {
        case 'Escape':
            clearSelections();
            break;
        case 'ArrowLeft':
            moveSelections('left', !e.shiftKey); // If shift key is pressed, we only want to move the end coordinate
            break;
        case 'ArrowUp':
            moveSelections('up', !e.shiftKey);
            break;
        case 'ArrowRight':
            moveSelections('right', !e.shiftKey);
            break;
        case 'ArrowDown':
            moveSelections('down', !e.shiftKey);
            break;
        case 'Tab':
            if (e.shiftKey) { moveSelections('left'); } else { moveSelections('right'); }
            break;
        case 'Enter':
            if (e.shiftKey) { moveSelections('up'); } else { moveSelections('down'); }
            break;
        default:
            return; // No changes
    }

    e.preventDefault();
});
