import $ from "jquery";
import {create2dArray, mirrorCharHorizontally, mirrorCharVertically, translateGlyphs} from "./utilities.js";
import {Cell, CellArea} from "./canvas.js";
import {triggerRefresh} from "./index.js";
import * as state from "./state.js";
import * as editor from "./editor.js";
import * as actions from "./actions.js";
import {shouldModifyAction} from "./actions.js";


// -------------------------------------------------------------------------------- Main API

export let polygons = [];
export let isDrawing = false; // Only true when mouse is down and polygon is being drawn
export let isMoving = false; // Only true when mouse is down and polygon is being moved
export let movableContent = null; // Selected glyph content IF there is any (it will be surrounded by dashed outline)
export let cursorCell = null;
export let cursorCellOrigin; // Where to move from on return key

export function init() {
    // actions.registerAction('selection.commit-selection', {
    //     name: 'Commit Move',
    //     callback: () => finishMovingContent(),
    //     enabled: () => !!movableContent,
    //     shortcut: 'Enter'
    // });

    actions.registerAction('selection.select-all', () => selectAll());

    clearCaches();
}

/**
 * Saves the current state of the various selection variables. Many things such as the polygons have to be serialized first.
 * We don't actually store this data in the save file, but it is stored in memory for undo/redo purposes.
 * TODO: We don't actually undo/redo selection data anymore, so all serialize/deserialize can be removed.
 */
export function serialize() {
    return {
        polygons: polygons.map(polygon => polygon.serialize()),
        movableContent: movableContent === null ? null : $.extend(true, {}, movableContent),
        cursorCell: cursorCell === null ? null : cursorCell.serialize(),
    };
}

/**
 * Loads a serialized state
 */
export function deserialize(data) {
    polygons = data.polygons.map(polygon => {
        switch (polygon.className) {
            case 'SelectionRect':
                return SelectionRect.deserialize(polygon);
            case 'SelectionText':
                return SelectionText.deserialize(polygon);
            case 'SelectionLine':
                return SelectionLine.deserialize(polygon);
            case 'SelectionLasso':
                return SelectionLasso.deserialize(polygon);
            case 'SelectionWand':
                return SelectionWand.deserialize(polygon);
            default:
                console.error(`Unknown polygon class: ${polygon.className}`);
                return null;
        }
    });
    movableContent = data.movableContent === null ? null : $.extend(true, {}, data.movableContent);
    cursorCell = data.cursorCell === null ? null : Cell.deserialize(data.cursorCell);
}

// Returns true if there is any area selected
export function hasSelection() {
    return polygons.some(polygon => polygon.hasArea);
}

// Returns true if there is any area selected or a cursor showing (i.e. a target visible on the canvas)
export function hasTarget() {
    return hasSelection() || cursorCell;
}

export function clear() {
    if (movableContent) { finishMovingContent(); }
    if (cursorCell) { hideCursor(); }
    polygons = [];
    triggerRefresh('selection');
}

// Empties the selection's contents. Does not clear the selection.
export function empty() {
    getSelectedCells().forEach(cell => {
        state.setCurrentCelGlyph(cell.row, cell.col, '', 0);
    });
}

// Select entire canvas
export function selectAll() {
    // selectAll works with both text-editor and selection-rect tools; only switch tools if not using one of those already
    if (state.config('tool') !== 'text-editor' && state.config('tool') !== 'selection-rect') {
        editor.changeTool('selection-rect');
    }

    if (cursorCell) {
        hideCursor();
    }

    polygons = [SelectionRect.drawableArea()];
    triggerRefresh('selection');
}

// Returns true if the given Cell is part of the selection
export function isSelectedCell(cell) {
    cacheSelectedCells();
    return caches.selectedCells.has(cellKey(cell));
}

// We allow the selection to be moved in all cases except for when the text-editor tool is being used and the
// shift key is down (in that case - we simply modify the text-editor polygon).
export function allowMovement(tool, mouseEvent) {
    return !(tool === 'text-editor' && mouseEvent.shiftKey)
}

export function setSelectionToSingleChar(char, color) {
    if (movableContent) {
        updateMovableContent(char, color);
    }
    else if (cursorCell) {
        // update cursor cell and then move to next cell
        state.setCurrentCelGlyph(cursorCell.row, cursorCell.col, char, color);
        moveCursorInDirection('right', false);
    }
    else {
        // update entire selection
        getSelectedCells().forEach(cell => {
            state.setCurrentCelGlyph(cell.row, cell.col, char, color);
        });
    }

    triggerRefresh('chars', 'producesText');

}



// -------------------------------------------------------------------------------- Selection Results


/**
 * Returns an object representing the smallest CellArea that bounds all polygons. The object contains a 2d array of its
 * chars and a 2d array of its colors. Gaps within the polygon(s) will be represented by undefined values.
 *
 * E.g. If the polygons (depicted by x's) were this:
 *
 *        .......
 *        ..xx...
 *        ..xx..x
 *        .......
 *
 *      Returns:
 *      {
 *          chars: [
 *              ['x', 'x', undefined, undefined, undefined],
 *              ['x', 'x', undefined, undefined, 'x']
 *          ],
 *          colors: [
 *             [0, 0, undefined, undefined, undefined],
 *             [0, 0, undefined, undefined, 0]
 *          ]
 *      }
 */
export function getSelectedValues() {
    if (!hasSelection()) {
        return [[]];
    }

    if (movableContent) {
        return movableContent;
    }

    // Start with 2d arrays of undefined elements
    const cellArea = getSelectedCellArea();
    let chars = create2dArray(cellArea.numRows, cellArea.numCols);
    let colors = create2dArray(cellArea.numRows, cellArea.numCols);

    polygons.forEach(polygon => {
        polygon.iterateCells((r, c) => {
            const [char, color] = state.getCurrentCelGlyph(r, c);
            chars[r - cellArea.topLeft.row][c - cellArea.topLeft.col] = char;
            colors[r - cellArea.topLeft.row][c - cellArea.topLeft.col] = color;
        });
    });

    return {
        chars: chars,
        colors: colors
    };
}

/**
 * Returns the smallest possible CellArea that includes all polygons.
 *
 * E.g. If the polygons (depicted by x's) were this:
 *
 *        .......
 *        ..xx...
 *        ..xx..x
 *        .......
 *
 *      Returns:
 *
 *        CellArea{ topLeft: {row:1,col:2}, bottomRight: {row:2,col:6} }
 *
 */
export function getSelectedCellArea() {
    if (!hasSelection()) {
        return null;
    }

    const topLeft = new Cell();
    const bottomRight = new Cell();
    
    for (const polygon of Object.values(polygons)) {
        if (!polygon.topLeft || !polygon.bottomRight) { continue; } // E.g. lasso that has not yet completed
        if (topLeft.row === undefined || polygon.topLeft.row < topLeft.row) { topLeft.row = polygon.topLeft.row; }
        if (topLeft.col === undefined || polygon.topLeft.col < topLeft.col) { topLeft.col = polygon.topLeft.col; }
        if (bottomRight.row === undefined || polygon.bottomRight.row > bottomRight.row) { bottomRight.row = polygon.bottomRight.row; }
        if (bottomRight.col === undefined || polygon.bottomRight.col > bottomRight.col) { bottomRight.col = polygon.bottomRight.col; }
    }

    if (topLeft.row === undefined) { return null; }

    return new CellArea(topLeft, bottomRight);
}

export function getSelectedRect() {
    if (!hasSelection()) {
        return null;
    }

    const cellArea = getSelectedCellArea();
    return new SelectionRect(cellArea.topLeft, cellArea.bottomRight);
}

/**
 * Returns a 1d array of Cell-like objects for all selected cells. The Cell-like objects have row and column attributes
 * like regular Cells, but none of the other methods. This function does not return full Cell objects to reduce memory cost.
 *
 * E.g. If the polygons (depicted by x's) were this:
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
export function getSelectedCells() {
    const result = [];
    polygons.forEach(polygon => {
        polygon.iterateCells((r, c) => {
            // Note: Not making a full Cell object for performance reasons. We don't need the other attributes of a Cell
            result.push({ row: r, col: c });
        });
    });
    return result;
}

/**
 * Returns all Cells adjacent to (and sharing the same color as) the targeted Cell
  */
export function getConnectedCells(cell, options) {
    if (!cell.isInBounds()) { return []; }

    const wand = new SelectionWand(cell, undefined, options);
    wand.complete();
    return wand.cells;
}



// -------------------------------------------------------------------------------- Events

export function setupMouseEvents(canvasControl) {
    let moveStep, hasMoved;

    canvasControl.$canvas.on('editor:mousedown', (evt, mouseEvent, cell, tool) => {
        switch(tool) {
            case 'selection-rect':
            case 'selection-line':
            case 'selection-lasso':
            case 'selection-wand':
            case 'text-editor':
                break;
            default:
                return; // Ignore all other tools
        }

        state.endHistoryModification();

        // If user clicks on the selection, we begin the 'moving' process (moving the selection area).
        if (isSelectedCell(cell) && allowMovement(tool, mouseEvent)) {
            isMoving = true;
            moveStep = cell;
            hasMoved = false;

            if (mouseEvent.metaKey && !movableContent) {
                startMovingContent();
                return;
            }

            triggerRefresh('selection');
            return;
        }

        // If user clicks anywhere on the canvas (without the multiple-select key down) we want to clear everything and start a new polygon
        if (!shouldModifyAction('editor.tools.selection.multiple', mouseEvent)) {
            clear();
        }

        if (cell.isInBounds()) {
            isDrawing = true;

            switch(tool) {
                case 'selection-rect':
                    polygons.push(new SelectionRect(cell, undefined, {
                        outline: shouldModifyAction('editor.tools.selection-rect.outline', mouseEvent)
                    }));
                    break;
                case 'selection-line':
                    polygons.push(new SelectionLine(cell));
                    break;
                case 'selection-lasso':
                    polygons.push(new SelectionLasso(cell));
                    break;
                case 'selection-wand':
                    const wand = new SelectionWand(cell, undefined, {
                        diagonal: true,
                        colorblind: shouldModifyAction('editor.tools.selection-wand.colorblind', mouseEvent)
                    });
                    wand.complete();
                    polygons.push(wand);
                    break;
                case 'text-editor':
                    cell = canvasControl.cursorAtExternalXY(mouseEvent.offsetX, mouseEvent.offsetY);

                    // We only ever use one polygon for the text-editor tool
                    if (polygons.length === 0) {
                        polygons.push(new SelectionText(cell));
                    }
                    else {
                        polygons[0].end = cell;
                    }

                    hasSelection() ? hideCursor() : moveCursorTo(cell);
                    break;
            }

            triggerRefresh('selection');
        }
    });

    canvasControl.$canvas.on('editor:mousemove', (evt, mouseEvent, cell, tool) => {
        if (isDrawing) {
            if (tool === 'text-editor') {
                cell = canvasControl.cursorAtExternalXY(mouseEvent.offsetX, mouseEvent.offsetY);
                lastPolygon().end = cell;
                triggerRefresh('selection');
                hasSelection() ? hideCursor() : moveCursorTo(cell);
            }
            else {
                lastPolygon().end = cell;
                triggerRefresh('selection');
            }
        }
        else if (isMoving) {
            moveDelta(cell.row - moveStep.row, cell.col - moveStep.col);

            if (!hasMoved && (cell.row !== moveStep.row || cell.col !== moveStep.col)) {
                hasMoved = true;
            }
            moveStep = cell;
        }
    });

    canvasControl.$canvas.on('editor:mouseup', (evt, mouseEvt, cell, tool) => {
        if (isDrawing) {
            lastPolygon().complete();
            isDrawing = false;
            triggerRefresh('selection');
        }
        else if (isMoving) {
            if (tool === 'text-editor' && !movableContent && !hasMoved) {
                clear();
                moveCursorTo(cell);
            }

            isMoving = false;
            const refresh = ['selection'];
            if (movableContent) { refresh.push('chars'); }
            if (cursorCell) { refresh.push('cursorCell'); }
            triggerRefresh(refresh);
        }
    });

    canvasControl.$canvas.on('editor:dblclick', (evt, mouseEvent, cell, tool) => {
        switch(tool) {
            case 'selection-rect':
            case 'selection-line':
            case 'selection-lasso':
            case 'selection-wand':
                break;
            default:
                return; // Ignore all other tools
        }

        moveCursorTo(cell);
    });
}


// -------------------------------------------------------------------------------- Moving Content

export function toggleMovingContent() {
    movableContent ? finishMovingContent() : startMovingContent();
}

export function startMovingContent() {
    if (cursorCell) { hideCursor(); } // Cannot move content and show cursor at the same time

    movableContent = getSelectedValues();

    empty();
    triggerRefresh('full', true);
}

export function finishMovingContent() {
    translateGlyphs(movableContent, getSelectedCellArea().topLeft, (r, c, char, color) => {
        state.setCurrentCelGlyph(r, c, char, color);
    });

    movableContent = null;
    triggerRefresh('full', true);
}

export function updateMovableContent(char, color) {
    function _update2dArray(array, value) {
        let r, c;

        for (r = 0; r < array.length; r++) {
            for (c = 0; c < array[r].length; c++) {
                if (array[r][c] !== undefined) {
                    array[r][c] = value;
                }
            }
        }
    }

    _update2dArray(movableContent.chars, char);
    _update2dArray(movableContent.colors, color);
}


// -------------------------------------------------------------------------------- Cursor

export function toggleCursor() {
    cursorCell ? hideCursor() : moveCursorToStart();
}

export function moveCursorTo(cell, updateOrigin = true) {
    if (movableContent) { finishMovingContent(); } // Cannot move content and show cursor at the same time

    cursorCell = cell;

    if (updateOrigin) {
        cursorCellOrigin = cell;
    }

    triggerRefresh('cursorCell');
}

export function moveCursorToStart() {
    if (state.config('tool') === 'text-editor') {
        // Move cursor to top-left cell of entire canvas. This only really happens during page init.
        moveCursorTo(new Cell(0, 0));
        matchPolygonToCursor();
        return;
    }

    cacheUniqueSortedCells();
    const cellData = caches.cellsLeftToRight[0];

    if (cellData) {
        moveCursorTo(new Cell(cellData[0], cellData[1]));
    }
}

// When using the text-editor tool, moves the cursor down one row and back to the origin column.
// This is similar to how Excel moves your cell when using the tab/return keys.
export function moveCursorCarriageReturn() {
    if (cursorCell) {
        if (state.config('tool') === 'text-editor') {
            let col = cursorCellOrigin.col,
                row = cursorCell.row + 1;

            if (row >= state.numRows()) {
                return; // Do not wrap around or move cursor at all
            }

            moveCursorTo(new Cell(row, col));
            matchPolygonToCursor();
        }
        else {
            moveCursorInDirection('down', false);
        }
    }
}

export function moveCursorInDirection(direction, updateOrigin = true, amount = 1) {
    if (cursorCell) {
        if (state.config('tool') === 'text-editor') {
            let col = cursorCell.col, row = cursorCell.row;

            if (direction === 'left') {
                col = Math.max(0, col - amount);
            }
            if (direction === 'up') {
                row = Math.max(0, row - amount);
            }
            if (direction === 'right') {
                // Note: When moving right, we intentionally allow column to go 1 space out of bounds
                col = Math.min(col + amount, state.numCols());
            }
            if (direction === 'down' && row < state.numRows() - 1) {
                row = Math.min(row + amount, state.numRows() - 1);
            }

            moveCursorTo(new Cell(row, col), updateOrigin);
            matchPolygonToCursor();
        }
        else {
            // For selection tools, the cursor traverse through the domain of the selection (wrapping when it reaches the end of a row)

            // TODO This case is hardcoded to step 1 space, but so far it does not need to support anything more
            if (amount !== 1) {
                console.error('moveCursorInDirection only supports an `amount` of `1` for selection tools');
            }

            cacheUniqueSortedCells();

            // Find the current targeted cell index
            let i;
            let cells = (direction === 'left' || direction === 'right') ? caches.cellsLeftToRight : caches.cellsTopToBottom;
            let length = cells.length;
            for (i = 0; i < length; i++) {
                if (cursorCell.row === cells[i][0] && cursorCell.col === cells[i][1]) {
                    break;
                }
            }

            // Step forward/backward
            (direction === 'right' || direction === 'down') ? i++ : i--;

            // Wrap around if necessary
            if (i >= length) { i = 0; }
            if (i < 0) { i = length - 1; }

            moveCursorTo(new Cell(cells[i][0], cells[i][1]), updateOrigin);
        }
    }
}

export function hideCursor() {
    cursorCell = null;
    triggerRefresh('cursorCell');
}

// Sets the current polygon to be a SelectionText of size 0 located at the cursor
function matchPolygonToCursor() {
    polygons = [new SelectionText(cursorCell)];
    triggerRefresh('selection');
}



// -------------------------------------------------------------------------------- Caching
// We cache some selection results to improve lookup times. Caches must be cleared whenever the selection changes.

let caches;

export function clearCaches() {
    caches = {};
}

function cacheUniqueSortedCells() {
    if (caches.cellsLeftToRight === undefined) {
        // using Set to find unique cell keys
        caches.cellsLeftToRight = new Set(getSelectedCells().map(cell => cellKey(cell)));

        // Convert cell keys to pairs of [row, col]
        caches.cellsLeftToRight = [...caches.cellsLeftToRight].map(cellKey => cellKeyToRowCol(cellKey));

        // Sort by row, then column
        caches.cellsLeftToRight.sort((a,b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    }
    if (caches.cellsTopToBottom === undefined) {
        // using Set to find unique cell keys
        caches.cellsTopToBottom = new Set(getSelectedCells().map(cell => cellKey(cell)));

        // Convert cell keys to pairs of [row, col]
        caches.cellsTopToBottom = [...caches.cellsTopToBottom].map(cellKey => cellKeyToRowCol(cellKey));

        // Sort by column, then row
        caches.cellsTopToBottom.sort((a,b) => a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]);
    }
}

function cacheSelectedCells() {
    if (caches.selectedCells === undefined) {
        caches.selectedCells = new Set(getSelectedCells().map(selectedCell => cellKey(selectedCell)));
    }
}


// -------------------------------------------------------------------------------- Translating/Modifying Polygons

function moveDelta(rowDelta, colDelta) {
    if (!hasSelection()) {
        return;
    }

    polygons.forEach(polygon => polygon.translate(rowDelta, colDelta));

    if (cursorCell) {
        cursorCell.row += rowDelta;
        cursorCell.col += colDelta;
    }

    const refresh = ['selection'];
    if (movableContent) { refresh.push('chars'); }
    if (cursorCell) { refresh.push('cursorCell'); }
    triggerRefresh(refresh);
}

// Move all polygons in a particular direction
export function moveInDirection(direction, amount, moveStart = true, moveEnd = true) {
    if (!hasTarget()) {
        return;
    }

    switch(direction) {
        case 'left':
            polygons.forEach(polygon => polygon.translate(0, -amount, moveStart, moveEnd));
            break;
        case 'up':
            polygons.forEach(polygon => polygon.translate(-amount, 0, moveStart, moveEnd));
            break;
        case 'right':
            polygons.forEach(polygon => polygon.translate(0, amount, moveStart, moveEnd));
            break;
        case 'down':
            polygons.forEach(polygon => polygon.translate(amount, 0, moveStart, moveEnd));
            break;
        default:
            console.warn(`Invalid direction: ${direction}`);
    }

    triggerRefresh(movableContent ? ['chars', 'selection'] : 'selection');
}

// Special handler for text-editor tool when arrow keys are pressed. We simulate a real text editor, where:
// - the arrow keys move the cursor
// - if you hold shift, the cursor begins highlighting text
// - if you keep holding shift and make your highlighted text area size 0, it reverts to a normal cursor
// - if you let go of shift after highlighting text and hit an arrow key, the cursor jumps to beginning/end of what
//   you had selected
export function handleTextEditorArrowKey(direction, shiftKey) {
    if (shiftKey) {
        if (cursorCell) {
            // Switch from a cursor to a selection area (by extending the current polygon and hiding the cursor)
            moveInDirection(direction, 1, false);
            hideCursor();
        }
        else {
            // Grow/shrink the selection area like normal
            moveInDirection(direction, 1, false);

            // However, if the selection area ever gets to be size 0, revert back to showing a cursor
            if (polygons[0] && !hasSelection()) {
                moveCursorTo(polygons[0].start);
            }
        }
    }
    else {
        if (cursorCell) {
            // Move the cursor like normal
            moveCursorInDirection(direction)
        }
        else {
            // Jump cursor to start/end of the selection area, and go back to just having a cursor
            switch(direction) {
                case 'left':
                case 'up':
                    moveCursorTo(polygons[0].topLeft);
                    break;
                case 'right':
                case 'down':
                    const target = polygons[0].bottomRight;
                    target.translate(0, 1); // Cursor actually needs to go one cell to the right of the selection end
                    moveCursorTo(target);
                    break;
                default:
                    console.warn(`Invalid direction: ${direction}`);
            }
            matchPolygonToCursor();
        }
    }
}

export function flipVertically(mirrorChars) {
    flip(false, true, mirrorChars);
}
export function flipHorizontally(mirrorChars) {
    flip(true, false, mirrorChars);
}

function flip(horizontally, vertically, mirrorChars) {
    const cellArea = getSelectedCellArea();
    const updates = []; // Have to batch the updates, and do them all at end (i.e. do not modify chars while iterating)

    function flipRow(oldRow) {
        return (cellArea.topLeft.row + cellArea.bottomRight.row) - oldRow;
    }
    function flipCol(oldCol) {
        return (cellArea.topLeft.col + cellArea.bottomRight.col) - oldCol;
    }

    getSelectedCells().forEach(cell => {
        let [char, color] = state.getCurrentCelGlyph(cell.row, cell.col);
        if (mirrorChars && horizontally) { char = mirrorCharHorizontally(char); }
        if (mirrorChars && vertically) { char = mirrorCharVertically(char); }
        updates.push({
            row: vertically ? flipRow(cell.row) : cell.row,
            col: horizontally ? flipCol(cell.col) : cell.col,
            char: char,
            color: color
        });
        state.setCurrentCelGlyph(cell.row, cell.col, '', 0);
    });

    updates.forEach(update => {
        state.setCurrentCelGlyph(update.row, update.col, update.char, update.color);
    })

    polygons.forEach(polygon => {
        if (vertically) { polygon.flipVertically(flipRow); }
        if (horizontally) { polygon.flipHorizontally(flipCol); }
    });

    triggerRefresh(['chars', 'selection'], true);
}

// -------------------------------------------------------------------------------- Cloning

export function cloneToAllFrames() {
    translateGlyphs(getSelectedValues(), getSelectedCellArea().topLeft, (r, c, char, color) => {
        state.iterateCelsForCurrentLayer(cel => {
            state.setCelGlyph(cel, r, c, char, color);
        })
    });

    triggerRefresh('full', true);
}




// -------------------------------------------------------------------------------- Helpers

function lastPolygon() {
    return polygons[polygons.length - 1];
}

// A unique way of identifying a cell (for Set lookup purposes)
function cellKey(cell) {
    return `${cell.row},${cell.col}`
}

// The inverse of cellKey
function cellKeyToRowCol(cellKey) {
    return cellKey.split(',').map(int => parseInt(int));
}





// -------------------------------------------------------------------------------- Polygon Classes

/**
 * SelectionPolygon is the base class for many types of selection shapes. All polygons have a start value (where the
 * user first clicked) and an end value (where the user's last mouse position was).
 *
 * Subclasses must implement 'iterateCells', 'draw', 'serialize' and 'deserialize' methods
 */
class SelectionPolygon {
    constructor(startCell, endCell = undefined, options = {}) {
        this.start = startCell;
        this.end = endCell === undefined ? startCell.clone() : endCell;
        this.options = options;
        this.completed = false;
    }

    set start(cell) {
        this._start = cell;
    }
    get start() {
        return this._start;
    }
    set end(cell) {
        this._end = cell;
    }
    get end() {
        return this._end;
    }

    get topLeft() {
        return new Cell(Math.min(this.start.row, this.end.row), Math.min(this.start.col, this.end.col));
    }
    get topRight() {
        return new Cell(Math.min(this.start.row, this.end.row), Math.max(this.start.col, this.end.col));
    }
    get bottomLeft() {
        return new Cell(Math.max(this.start.row, this.end.row), Math.min(this.start.col, this.end.col));
    }
    get bottomRight() {
        return new Cell(Math.max(this.start.row, this.end.row), Math.max(this.start.col, this.end.col));
    }

    // Return true if the polygon has visible area. By default, even the smallest polygon occupies a 1x1 cell and is
    // visible. Some subclasses override this.
    get hasArea() {
        return true;
    }

    complete() {
        this.completed = true;
    }

    translate(rowDelta, colDelta, moveStart = true, moveEnd = true) {
        if (moveStart) {
            this.start.row += rowDelta;
            this.start.col += colDelta;
        }
        if (moveEnd) {
            this.end.row += rowDelta;
            this.end.col += colDelta;
        }
    }

    flipVertically(flipRow) {
        this.start.row = flipRow(this.start.row);
        this.end.row = flipRow(this.end.row);
    }

    flipHorizontally(flipCol) {
        this.start.col = flipCol(this.start.col);
        this.end.col = flipCol(this.end.col);
    }


}

class SelectionLine extends SelectionPolygon {
    serialize() {
        return { className: 'SelectionLine', start: this.start.serialize(), end: this.end.serialize() };
    }

    static deserialize(data) {
        return new SelectionLine(Cell.deserialize(data.start), Cell.deserialize(data.end));
    }

    iterateCells(callback) {
        this.start.lineTo(this.end).forEach(cell => callback(cell.row, cell.col));
    }

    draw(context) {
        this.start.lineTo(this.end).forEach(cell => {
            if (cell.isInBounds()) {
                context.fillRect(...cell.xywh);
            }
        });
    }
}

class SelectionRect extends SelectionPolygon {
    serialize() {
        return { className: 'SelectionRect', start: this.start.serialize(), end: this.end.serialize() };
    }

    static deserialize(data) {
        return new SelectionRect(Cell.deserialize(data.start), Cell.deserialize(data.end));
    }

    static drawableArea() {
        return new SelectionRect(new Cell(0, 0), new Cell(state.numRows() - 1, state.numCols() - 1));
    }

    iterateCells(callback) {
        if (this.options.outline) {
            const minRow = this.topLeft.row;
            const minCol = this.topLeft.col;
            const maxRow = this.bottomRight.row;
            const maxCol = this.bottomRight.col;

            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    // Only call callback if on outer row/col of rectangle
                    if (r === minRow || c === minCol || r === maxRow || c === maxCol) {
                        callback(r, c);
                    }
                }
            }
        }
        else {
            this._toCellArea().iterate(callback);
        }
    }

    draw(context) {
        if (this.options.outline) {
            context.fillRect(...new CellArea(this.topLeft, this.topRight).bindToDrawableArea().xywh);
            context.fillRect(...new CellArea(this.topLeft, this.bottomLeft).bindToDrawableArea().xywh);
            context.fillRect(...new CellArea(this.topRight, this.bottomRight).bindToDrawableArea().xywh);
            context.fillRect(...new CellArea(this.bottomLeft, this.bottomRight).bindToDrawableArea().xywh);
        }
        else {
            context.fillRect(...this._toCellArea().bindToDrawableArea().xywh);
        }
    }

    // Note: SelectionRect is the only Polygon that needs to implement `stroke`, because we only use stroke() for
    // outlinePolygon() and the outline is always a rectangle.
    stroke(context) {
        context.beginPath();
        context.rect(...this._toCellArea().xywh);
        context.stroke();
    }

    _toCellArea() {
        return new CellArea(this.topLeft, this.bottomRight);
    }
}

/**
 * SelectionText is similar to SelectionRect, but it can occupy 0 width. Similar to selecting text in a text editor,
 * when you first click-and-drag, your cursor highlights a single line between two characters (no chars are selected).
 * As you drag in a particular direction, you will highlight 0 or more characters. To achieve this effect, we can simply
 * subtract 1 from the end column once the user highlights more than 1 cell.
 */
class SelectionText extends SelectionRect {
    serialize() {
        return $.extend(super.serialize(), { className: 'SelectionText' });
    }

    static deserialize(data) {
        return new SelectionText(Cell.deserialize(data.start), Cell.deserialize(data.end));
    }

    get bottomRight() {
        let maxRow = Math.max(this.start.row, this.end.row);
        let maxCol = Math.max(this.start.col, this.end.col);

        if (this._truncateLastCol()) {
            maxCol -= 1;
        }

        return new Cell(maxRow, maxCol);
    }

    get hasArea() {
        return this.topLeft.col !== this.bottomRight.col + 1;
    }

    // As mentioned in the class definition, the easiest way to allow the user to select between 0 and some number of
    // columns is to truncate the final column of a rect. The only time we don't do this is when highlighting a
    // rect that is more than 1 row tall and only 1 column wide; we don't want it to look like there is a rect with
    // zero width spanning multiple columns.
    _truncateLastCol() {
        return this.start.row === this.end.row || this.start.col !== this.end.col;
    }

    flipHorizontally(flipCol) {
        if (this._truncateLastCol()) {
            // If we truncated the final column, have to add 1 for the flip to work correctly
            this.start.col = flipCol(this.start.col) + 1;
            this.end.col = flipCol(this.end.col) + 1;
        }
        else {
            super.flipHorizontally(flipCol);
        }
    }
}

/**
 * A SelectionLasso starts off as just an array of Cells (_lassoCells) as the user clicks and drags the mouse. When
 * the mouse click is released the lasso will connect the end point to the start point to complete the polygon. Then
 * the polygon is filled in and stored as an array of rectangular CellAreas (_lassoAreas).
 */
class SelectionLasso extends SelectionPolygon {
    serialize() {
        return {
            className: 'SelectionLasso',
            areas: this._lassoAreas.map(area => area.serialize())
        };
    }

    static deserialize(data) {
        let lasso = new SelectionLasso(null, null);
        lasso._lassoAreas = data.areas.map(area => CellArea.deserialize(area));
        lasso._cacheEndpoints();
        lasso.completed = true;
        return lasso;
    }

    iterateCells(callback) {
        if (this._lassoAreas) {
            this._lassoAreas.forEach(area => area.iterate(callback));
        }
        else {
            this._lassoCells.forEach(cell => callback(cell.row, cell.col));
        }
    }

    draw(context) {
        if (this._boundedLassoAreas) {
            this._boundedLassoAreas.forEach(area => context.fillRect(...area.xywh));
        }
        else {
            this._lassoCells.forEach(cell => {
                if (cell.isInBounds()) {
                    context.fillRect(...cell.xywh);
                }
            });
        }
    }

    set start(cell) {
        super.start = cell;
        this._lassoCells = [];
    }

    set end(cell) {
        super.end = cell;

        const previousEnd = this._lassoCells[this._lassoCells.length - 1];
        if (previousEnd === undefined || previousEnd.row !== cell.row || previousEnd.col !== cell.col) {
            if (previousEnd && !cell.isAdjacentTo(previousEnd)) {
                // Mouse might skip cells if moved quickly, so fill in any skips
                previousEnd.lineTo(cell, false).forEach(cell => {
                    this._lassoCells.push(cell);
                });
            }

            // Note: Duplicates cells ARE allowed, as long as they are not consecutive
            this._lassoCells.push(cell);
        }
    }

    get start() {
        return super.start; // Have to override get since set is overridden
    }
    get end() {
        return super.end; // Have to override get since set is overridden
    }

    get topLeft() {
        return this._topLeft; // Using a cached value
    }

    get bottomRight() {
        return this._bottomRight; // Using a cached value
    }

    complete() {
        // Connect the end point back to the start with a line to finish the full border chain
        let chain = this._lassoCells.map(cell => ({row: cell.row, col: cell.col}));
        this.end.lineTo(this.start, false).forEach(cell => {
            chain.push({row: cell.row, col: cell.col});
        });

        // Update each link in the chain with a reference to its previous/next link
        for (let i = 0; i < chain.length; i++) {
            chain[i].prev = (i === 0) ? chain[chain.length - 1] : chain[i - 1];
            chain[i].next = (i === chain.length - 1) ? chain[0] : chain[i + 1];
        }

        // Organize chain links into a 2d array sorted by row/col
        let sortedLinks = [];
        let minRow, maxRow;
        chain.forEach(link => {
            if (sortedLinks[link.row] === undefined) {
                sortedLinks[link.row] = [];
                if(minRow === undefined || link.row < minRow) { minRow = link.row; }
                if(maxRow === undefined || link.row > maxRow) { maxRow = link.row; }
            }
            sortedLinks[link.row].push(link);
        });
        sortedLinks.splice(0, minRow); // Remove empty rows from 0 to the first row
        sortedLinks.forEach(row => row.sort((a, b) => a.col - b.col));

        /**
         * Iterate through the sortedLinks, applying "point in polygon" logic to determine if a cell is inside or outside
         * the polygon (https://en.wikipedia.org/wiki/Point_in_polygon).
         *
         * Because we have discrete cells, a polygon edge/corner can "double back" on itself along the same path. We
         * have to implement special handlers for these cases to calculate whether it counts as 1 or 2 "crossings" in
         * point-in-polygon test. For example:
         *
         *       .....###...
         *       ..####.###.
         *       ..#......#.
         *       ..#...#..#. <-- the # in the middle "doubles back" towards the bottom
         *       ..########.
         *       ...........
         *
         * A "lasso area" is a CellArea that is on a single row. There may be multiple lasso areas per row if they are
         * separated by gaps. In the above example, the 2nd row (row index 1) would have 2 lasso areas.
         * We use areas instead of keeping track of individual cells to maximize performance.
         */
        this._lassoAreas = [];
        sortedLinks.forEach(rowOfLinks => {
            let inside = false;

            // Iterate through the row. Each time we cross a polygon edge, we toggle whether we are inside the polygon or not.
            for (let i = 0; i < rowOfLinks.length; i++) {
                const link = rowOfLinks[i];
                const cell = new Cell(link.row, link.col);

                if (inside) {
                    this._lassoAreas[this._lassoAreas.length - 1].bottomRight = cell;
                }
                else {
                    this._lassoAreas.push(new CellArea(cell, cell.clone()));
                }

                // If crossing a boundary, toggle 'inside' boolean
                if ((link.next.row > link.row && link.prev.row <= link.row) ||
                    (link.prev.row > link.row && link.next.row <= link.row)) {
                    inside = !inside;
                }
            }
        });

        this._cacheEndpoints();

        super.complete();
    }

    translate(rowDelta, colDelta) {
        this._lassoAreas.forEach(area => {
            area.topLeft.row += rowDelta;
            area.topLeft.col += colDelta;
            area.bottomRight.row += rowDelta;
            area.bottomRight.col += colDelta;
        })

        this._cacheEndpoints();
    }

    flipVertically(flipRow) {
        this._lassoAreas.forEach(area => {
            const topLeftRow = area.topLeft.row, bottomRightRow = area.bottomRight.row;
            area.topLeft.row = flipRow(bottomRightRow);
            area.bottomRight.row = flipRow(topLeftRow);
        });

        this._cacheEndpoints();
    }

    flipHorizontally(flipCol) {
        this._lassoAreas.forEach(area => {
            const topLeftCol = area.topLeft.col, bottomRightCol = area.bottomRight.col;
            area.topLeft.col = flipCol(bottomRightCol);
            area.bottomRight.col = flipCol(topLeftCol);
        });

        this._cacheEndpoints();
    }

    _cacheEndpoints() {
        this._boundedLassoAreas = this._lassoAreas.map(area => area.clone().bindToDrawableArea(true));

        // _lassoAreas is sorted by row, so we can determine the min/max row just from the first/last areas
        const minRow = this._lassoAreas[0].topLeft.row;
        const maxRow = this._lassoAreas[this._lassoAreas.length - 1].bottomRight.row;

        // Any of the areas could have the min/max col, so have to search through all of them
        const minCol = Math.min(...this._lassoAreas.map(area => area.topLeft.col));
        const maxCol = Math.max(...this._lassoAreas.map(area => area.bottomRight.col));

        this._topLeft = new Cell(minRow, minCol);
        this._bottomRight = new Cell(maxRow, maxCol);
    }
}



class SelectionWand extends SelectionPolygon {

    serialize() {
        return {
            className: 'SelectionWand',
            cells: this._cells.map(cell => cell.serialize())
        };
    }

    static deserialize(data) {
        let wand = new SelectionWand(null, null);
        wand._cells = data.cells.map(cell => Cell.deserialize(cell));
        wand._cacheEndpoints();
        wand.completed = true;
        return wand;
    }

    get cells() {
        return this._cells;
    }

    iterateCells(callback) {
        this._cells.forEach(cell => callback(cell.row, cell.col));
    }

    draw(context) {
        this._cells.forEach(cell => {
            if (cell.isInBounds()) {
                context.fillRect(...cell.xywh);
            }
        });
    }

    get topLeft() {
        return this._topLeft; // Using a cached value
    }

    get bottomRight() {
        return this._bottomRight; // Using a cached value
    }

    translate(rowDelta, colDelta) {
        this._cells.forEach(cell => {
            cell.row += rowDelta;
            cell.col += colDelta;
        });

        this._cacheEndpoints();
    }

    flipVertically(flipRow) {
        this._cells.forEach(cell => {
            cell.row = flipRow(cell.row);
        })

        this._cacheEndpoints();
    }

    flipHorizontally(flipCol) {
        this._cells.forEach(cell => {
            cell.col = flipCol(cell.col);
        })

        this._cacheEndpoints();
    }

    complete() {
        const cellHash = {};
        const [startChar, startColor] = state.getCurrentCelGlyph(this.start.row, this.start.col);
        const isBlank = startChar === '';
        const colorblind = this.options.colorblind;
        const diagonal = this.options.diagonal;

        function spread(cell) {
            if (cellHash[cellKey(cell)] === undefined) {
                const [char, color] = state.getCurrentCelGlyph(cell.row, cell.col);
                if (char === undefined) { return; }

                // If starting character was blank, only keep blank cells. Otherwise only keep non-blank cells
                if (isBlank ? char !== '' : char === '') { return; }

                // Character colors have to match unless colorblind option is true
                if (!isBlank && !colorblind && color !== startColor) { return; }

                // Add cell to result
                cellHash[cellKey(cell)] = new Cell(cell.row, cell.col);

                // Recursive call to adjacent cells (note: not instantiating full Cell objects for performance reasons)
                spread({ row: cell.row - 1, col: cell.col });
                spread({ row: cell.row, col: cell.col + 1 });
                spread({ row: cell.row + 1, col: cell.col });
                spread({ row: cell.row, col: cell.col - 1 });

                if (diagonal) {
                    spread({ row: cell.row - 1, col: cell.col - 1 });
                    spread({ row: cell.row - 1, col: cell.col + 1 });
                    spread({ row: cell.row + 1, col: cell.col + 1 });
                    spread({ row: cell.row + 1, col: cell.col - 1 });
                }
            }
        }

        spread(this.start);

        this._cells = Object.values(cellHash);
        this._cacheEndpoints();

        super.complete();
    }

    _cacheEndpoints() {
        const minRow = Math.min(...this._cells.map(cell => cell.row));
        const maxRow = Math.max(...this._cells.map(cell => cell.row));
        const minCol = Math.min(...this._cells.map(cell => cell.col));
        const maxCol = Math.max(...this._cells.map(cell => cell.col));

        this._topLeft = new Cell(minRow, minCol);
        this._bottomRight = new Cell(maxRow, maxCol);
    }

}