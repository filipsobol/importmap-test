/*!
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
import { Plugin } from '@ckeditor/ckeditor5-core';
import { EventInfo, toUnit, delay, DomEmitterMixin, global, Rect, ResizeObserver, env, uid, createElement } from '@ckeditor/ckeditor5-utils';
import { DomEventObserver, DataTransfer, MouseObserver, LiveRange } from '@ckeditor/ckeditor5-engine';
import { Widget, isWidget } from '@ckeditor/ckeditor5-widget';
import { View } from '@ckeditor/ckeditor5-ui';
import { throttle } from 'lodash-es';

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/clipboardobserver
 */
/**
 * Clipboard events observer.
 *
 * Fires the following events:
 *
 * * {@link module:engine/view/document~Document#event:clipboardInput},
 * * {@link module:engine/view/document~Document#event:paste},
 * * {@link module:engine/view/document~Document#event:copy},
 * * {@link module:engine/view/document~Document#event:cut},
 * * {@link module:engine/view/document~Document#event:drop},
 * * {@link module:engine/view/document~Document#event:dragover},
 * * {@link module:engine/view/document~Document#event:dragging},
 * * {@link module:engine/view/document~Document#event:dragstart},
 * * {@link module:engine/view/document~Document#event:dragend},
 * * {@link module:engine/view/document~Document#event:dragenter},
 * * {@link module:engine/view/document~Document#event:dragleave}.
 *
 * **Note**: This observer is not available by default (ckeditor5-engine does not add it on its own).
 * To make it available, it needs to be added to {@link module:engine/view/document~Document} by using
 * the {@link module:engine/view/view~View#addObserver `View#addObserver()`} method. Alternatively, you can load the
 * {@link module:clipboard/clipboard~Clipboard} plugin which adds this observer automatically (because it uses it).
 */
class ClipboardObserver extends DomEventObserver {
    constructor(view) {
        super(view);
        this.domEventType = [
            'paste', 'copy', 'cut', 'drop', 'dragover', 'dragstart', 'dragend', 'dragenter', 'dragleave'
        ];
        const viewDocument = this.document;
        this.listenTo(viewDocument, 'paste', handleInput('clipboardInput'), { priority: 'low' });
        this.listenTo(viewDocument, 'drop', handleInput('clipboardInput'), { priority: 'low' });
        this.listenTo(viewDocument, 'dragover', handleInput('dragging'), { priority: 'low' });
        function handleInput(type) {
            return (evt, data) => {
                data.preventDefault();
                const targetRanges = data.dropRange ? [data.dropRange] : null;
                const eventInfo = new EventInfo(viewDocument, type);
                viewDocument.fire(eventInfo, {
                    dataTransfer: data.dataTransfer,
                    method: evt.name,
                    targetRanges,
                    target: data.target,
                    domEvent: data.domEvent
                });
                // If CKEditor handled the input, do not bubble the original event any further.
                // This helps external integrations recognize that fact and act accordingly.
                // https://github.com/ckeditor/ckeditor5-upload/issues/92
                if (eventInfo.stop.called) {
                    data.stopPropagation();
                }
            };
        }
    }
    onDomEvent(domEvent) {
        const nativeDataTransfer = 'clipboardData' in domEvent ? domEvent.clipboardData : domEvent.dataTransfer;
        const cacheFiles = domEvent.type == 'drop' || domEvent.type == 'paste';
        const evtData = {
            dataTransfer: new DataTransfer(nativeDataTransfer, { cacheFiles })
        };
        if (domEvent.type == 'drop' || domEvent.type == 'dragover') {
            evtData.dropRange = getDropViewRange(this.view, domEvent);
        }
        this.fire(domEvent.type, domEvent, evtData);
    }
}
function getDropViewRange(view, domEvent) {
    const domDoc = domEvent.target.ownerDocument;
    const x = domEvent.clientX;
    const y = domEvent.clientY;
    let domRange;
    // Webkit & Blink.
    if (domDoc.caretRangeFromPoint && domDoc.caretRangeFromPoint(x, y)) {
        domRange = domDoc.caretRangeFromPoint(x, y);
    }
    // FF.
    else if (domEvent.rangeParent) {
        domRange = domDoc.createRange();
        domRange.setStart(domEvent.rangeParent, domEvent.rangeOffset);
        domRange.collapse(true);
    }
    if (domRange) {
        return view.domConverter.domRangeToView(domRange);
    }
    return null;
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/utils/plaintexttohtml
 */
/**
 * Converts plain text to its HTML-ized version.
 *
 * @param text The plain text to convert.
 * @returns HTML generated from the plain text.
 */
function plainTextToHtml(text) {
    text = text
        // Encode <>.
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Creates a paragraph for each double line break.
        .replace(/\r?\n\r?\n/g, '</p><p>')
        // Creates a line break for each single line break.
        .replace(/\r?\n/g, '<br>')
        // Replace tabs with four spaces.
        .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
        // Preserve trailing spaces (only the first and last one – the rest is handled below).
        .replace(/^\s/, '&nbsp;')
        .replace(/\s$/, '&nbsp;')
        // Preserve other subsequent spaces now.
        .replace(/\s\s/g, ' &nbsp;');
    if (text.includes('</p><p>') || text.includes('<br>')) {
        // If we created paragraphs above, add the trailing ones.
        text = `<p>${text}</p>`;
    }
    // TODO:
    // * What about '\nfoo' vs ' foo'?
    return text;
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/utils/normalizeclipboarddata
 */
/**
 * Removes some popular browser quirks out of the clipboard data (HTML).
 * Removes all HTML comments. These are considered an internal thing and it makes little sense if they leak into the editor data.
 *
 * @param data The HTML data to normalize.
 * @returns Normalized HTML.
 */
function normalizeClipboardData(data) {
    return data
        .replace(/<span(?: class="Apple-converted-space"|)>(\s+)<\/span>/g, (fullMatch, spaces) => {
        // Handle the most popular and problematic case when even a single space becomes an nbsp;.
        // Decode those to normal spaces. Read more in https://github.com/ckeditor/ckeditor5-clipboard/issues/2.
        if (spaces.length == 1) {
            return ' ';
        }
        return spaces;
    })
        // Remove all HTML comments.
        .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
// Elements which should not have empty-line padding.
// Most `view.ContainerElement` want to be separate by new-line, but some are creating one structure
// together (like `<li>`) so it is better to separate them by only one "\n".
const smallPaddingElements = ['figcaption', 'li'];
const listElements = ['ol', 'ul'];
/**
 * Converts {@link module:engine/view/item~Item view item} and all of its children to plain text.
 *
 * @param viewItem View item to convert.
 * @returns Plain text representation of `viewItem`.
 */
function viewToPlainText(viewItem) {
    if (viewItem.is('$text') || viewItem.is('$textProxy')) {
        return viewItem.data;
    }
    if (viewItem.is('element', 'img') && viewItem.hasAttribute('alt')) {
        return viewItem.getAttribute('alt');
    }
    if (viewItem.is('element', 'br')) {
        return '\n'; // Convert soft breaks to single line break (#8045).
    }
    /**
     * Item is a document fragment, attribute element or container element. It doesn't
     * have it's own text value, so we need to convert its children elements.
     */
    let text = '';
    let prev = null;
    for (const child of viewItem.getChildren()) {
        text += newLinePadding(child, prev) + viewToPlainText(child);
        prev = child;
    }
    return text;
}
/**
 * Returns new line padding to prefix the given elements with.
 */
function newLinePadding(element, previous) {
    if (!previous) {
        // Don't add padding to first elements in a level.
        return '';
    }
    if (element.is('element', 'li') && !element.isEmpty && element.getChild(0).is('containerElement')) {
        // Separate document list items with empty lines.
        return '\n\n';
    }
    if (listElements.includes(element.name) && listElements.includes(previous.name)) {
        /**
         * Because `<ul>` and `<ol>` are AttributeElements, two consecutive lists will not have any padding between
         * them (see the `if` statement below). To fix this, we need to make an exception for this case.
         */
        return '\n\n';
    }
    if (!element.is('containerElement') && !previous.is('containerElement')) {
        // Don't add padding between non-container elements.
        return '';
    }
    if (smallPaddingElements.includes(element.name) || smallPaddingElements.includes(previous.name)) {
        // Add small padding between selected container elements.
        return '\n';
    }
    // Add empty lines between container elements.
    return '\n\n';
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/clipboardpipeline
 */
// Input pipeline events overview:
//
//              ┌──────────────────────┐          ┌──────────────────────┐
//              │     view.Document    │          │     view.Document    │
//              │         paste        │          │         drop         │
//              └───────────┬──────────┘          └───────────┬──────────┘
//                          │                                 │
//                          └────────────────┌────────────────┘
//                                           │
//                                 ┌─────────V────────┐
//                                 │   view.Document  │   Retrieves text/html or text/plain from data.dataTransfer
//                                 │  clipboardInput  │   and processes it to view.DocumentFragment.
//                                 └─────────┬────────┘
//                                           │
//                               ┌───────────V───────────┐
//                               │   ClipboardPipeline   │   Converts view.DocumentFragment to model.DocumentFragment.
//                               │  inputTransformation  │
//                               └───────────┬───────────┘
//                                           │
//                                ┌──────────V──────────┐
//                                │  ClipboardPipeline  │   Calls model.insertContent().
//                                │   contentInsertion  │
//                                └─────────────────────┘
//
//
// Output pipeline events overview:
//
//              ┌──────────────────────┐          ┌──────────────────────┐
//              │     view.Document    │          │     view.Document    │   Retrieves the selected model.DocumentFragment
//              │         copy         │          │          cut         │   and fires the `outputTransformation` event.
//              └───────────┬──────────┘          └───────────┬──────────┘
//                          │                                 │
//                          └────────────────┌────────────────┘
//                                           │
//                               ┌───────────V───────────┐
//                               │   ClipboardPipeline   │   Processes model.DocumentFragment and converts it to
//                               │  outputTransformation │   view.DocumentFragment.
//                               └───────────┬───────────┘
//                                           │
//                                 ┌─────────V────────┐
//                                 │   view.Document  │   Processes view.DocumentFragment to text/html and text/plain
//                                 │  clipboardOutput │   and stores the results in data.dataTransfer.
//                                 └──────────────────┘
//
/**
 * The clipboard pipeline feature. It is responsible for intercepting the `paste` and `drop` events and
 * passing the pasted content through a series of events in order to insert it into the editor's content.
 * It also handles the `cut` and `copy` events to fill the native clipboard with the serialized editor's data.
 *
 * # Input pipeline
 *
 * The behavior of the default handlers (all at a `low` priority):
 *
 * ## Event: `paste` or `drop`
 *
 * 1. Translates the event data.
 * 2. Fires the {@link module:engine/view/document~Document#event:clipboardInput `view.Document#clipboardInput`} event.
 *
 * ## Event: `view.Document#clipboardInput`
 *
 * 1. If the `data.content` event field is already set (by some listener on a higher priority), it takes this content and fires the event
 *    from the last point.
 * 2. Otherwise, it retrieves `text/html` or `text/plain` from `data.dataTransfer`.
 * 3. Normalizes the raw data by applying simple filters on string data.
 * 4. Processes the raw data to {@link module:engine/view/documentfragment~DocumentFragment `view.DocumentFragment`} with the
 *    {@link module:engine/controller/datacontroller~DataController#htmlProcessor `DataController#htmlProcessor`}.
 * 5. Fires the {@link module:clipboard/clipboardpipeline~ClipboardPipeline#event:inputTransformation
 *   `ClipboardPipeline#inputTransformation`} event with the view document fragment in the `data.content` event field.
 *
 * ## Event: `ClipboardPipeline#inputTransformation`
 *
 * 1. Converts {@link module:engine/view/documentfragment~DocumentFragment `view.DocumentFragment`} from the `data.content` field to
 *    {@link module:engine/model/documentfragment~DocumentFragment `model.DocumentFragment`}.
 * 2. Fires the {@link module:clipboard/clipboardpipeline~ClipboardPipeline#event:contentInsertion `ClipboardPipeline#contentInsertion`}
 *    event with the model document fragment in the `data.content` event field.
 *    **Note**: The `ClipboardPipeline#contentInsertion` event is fired within a model change block to allow other handlers
 *    to run in the same block without post-fixers called in between (i.e., the selection post-fixer).
 *
 * ## Event: `ClipboardPipeline#contentInsertion`
 *
 * 1. Calls {@link module:engine/model/model~Model#insertContent `model.insertContent()`} to insert `data.content`
 *    at the current selection position.
 *
 * # Output pipeline
 *
 * The behavior of the default handlers (all at a `low` priority):
 *
 * ## Event: `copy`, `cut` or `dragstart`
 *
 * 1. Retrieves the selected {@link module:engine/model/documentfragment~DocumentFragment `model.DocumentFragment`} by calling
 *    {@link module:engine/model/model~Model#getSelectedContent `model#getSelectedContent()`}.
 * 2. Converts the model document fragment to {@link module:engine/view/documentfragment~DocumentFragment `view.DocumentFragment`}.
 * 3. Fires the {@link module:engine/view/document~Document#event:clipboardOutput `view.Document#clipboardOutput`} event
 *    with the view document fragment in the `data.content` event field.
 *
 * ## Event: `view.Document#clipboardOutput`
 *
 * 1. Processes `data.content` to HTML and plain text with the
 *    {@link module:engine/controller/datacontroller~DataController#htmlProcessor `DataController#htmlProcessor`}.
 * 2. Updates the `data.dataTransfer` data for `text/html` and `text/plain` with the processed data.
 * 3. For the `cut` method, calls {@link module:engine/model/model~Model#deleteContent `model.deleteContent()`}
 *    on the current selection.
 *
 * Read more about the clipboard integration in the {@glink framework/deep-dive/clipboard clipboard deep-dive} guide.
 */
class ClipboardPipeline extends Plugin {
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'ClipboardPipeline';
    }
    /**
     * @inheritDoc
     */
    init() {
        const editor = this.editor;
        const view = editor.editing.view;
        view.addObserver(ClipboardObserver);
        this._setupPasteDrop();
        this._setupCopyCut();
    }
    /**
     * Fires Clipboard `'outputTransformation'` event for given parameters.
     *
     * @internal
     */
    _fireOutputTransformationEvent(dataTransfer, selection, method) {
        const content = this.editor.model.getSelectedContent(selection);
        this.fire('outputTransformation', {
            dataTransfer,
            content,
            method
        });
    }
    /**
     * The clipboard paste pipeline.
     */
    _setupPasteDrop() {
        const editor = this.editor;
        const model = editor.model;
        const view = editor.editing.view;
        const viewDocument = view.document;
        // Pasting is disabled when selection is in non-editable place.
        // Dropping is disabled in drag and drop handler.
        this.listenTo(viewDocument, 'clipboardInput', (evt, data) => {
            if (data.method == 'paste' && !editor.model.canEditAt(editor.model.document.selection)) {
                evt.stop();
            }
        }, { priority: 'highest' });
        this.listenTo(viewDocument, 'clipboardInput', (evt, data) => {
            const dataTransfer = data.dataTransfer;
            let content;
            // Some feature could already inject content in the higher priority event handler (i.e., codeBlock).
            if (data.content) {
                content = data.content;
            }
            else {
                let contentData = '';
                if (dataTransfer.getData('text/html')) {
                    contentData = normalizeClipboardData(dataTransfer.getData('text/html'));
                }
                else if (dataTransfer.getData('text/plain')) {
                    contentData = plainTextToHtml(dataTransfer.getData('text/plain'));
                }
                content = this.editor.data.htmlProcessor.toView(contentData);
            }
            const eventInfo = new EventInfo(this, 'inputTransformation');
            this.fire(eventInfo, {
                content,
                dataTransfer,
                targetRanges: data.targetRanges,
                method: data.method
            });
            // If CKEditor handled the input, do not bubble the original event any further.
            // This helps external integrations recognize this fact and act accordingly.
            // https://github.com/ckeditor/ckeditor5-upload/issues/92
            if (eventInfo.stop.called) {
                evt.stop();
            }
            view.scrollToTheSelection();
        }, { priority: 'low' });
        this.listenTo(this, 'inputTransformation', (evt, data) => {
            if (data.content.isEmpty) {
                return;
            }
            const dataController = this.editor.data;
            // Convert the pasted content into a model document fragment.
            // The conversion is contextual, but in this case an "all allowed" context is needed
            // and for that we use the $clipboardHolder item.
            const modelFragment = dataController.toModel(data.content, '$clipboardHolder');
            if (modelFragment.childCount == 0) {
                return;
            }
            evt.stop();
            // Fire content insertion event in a single change block to allow other handlers to run in the same block
            // without post-fixers called in between (i.e., the selection post-fixer).
            model.change(() => {
                this.fire('contentInsertion', {
                    content: modelFragment,
                    method: data.method,
                    dataTransfer: data.dataTransfer,
                    targetRanges: data.targetRanges
                });
            });
        }, { priority: 'low' });
        this.listenTo(this, 'contentInsertion', (evt, data) => {
            data.resultRange = model.insertContent(data.content);
        }, { priority: 'low' });
    }
    /**
     * The clipboard copy/cut pipeline.
     */
    _setupCopyCut() {
        const editor = this.editor;
        const modelDocument = editor.model.document;
        const view = editor.editing.view;
        const viewDocument = view.document;
        const onCopyCut = (evt, data) => {
            const dataTransfer = data.dataTransfer;
            data.preventDefault();
            this._fireOutputTransformationEvent(dataTransfer, modelDocument.selection, evt.name);
        };
        this.listenTo(viewDocument, 'copy', onCopyCut, { priority: 'low' });
        this.listenTo(viewDocument, 'cut', (evt, data) => {
            // Cutting is disabled when selection is in non-editable place.
            // See: https://github.com/ckeditor/ckeditor5-clipboard/issues/26.
            if (!editor.model.canEditAt(editor.model.document.selection)) {
                data.preventDefault();
            }
            else {
                onCopyCut(evt, data);
            }
        }, { priority: 'low' });
        this.listenTo(this, 'outputTransformation', (evt, data) => {
            const content = editor.data.toView(data.content);
            viewDocument.fire('clipboardOutput', {
                dataTransfer: data.dataTransfer,
                content,
                method: data.method
            });
        }, { priority: 'low' });
        this.listenTo(viewDocument, 'clipboardOutput', (evt, data) => {
            if (!data.content.isEmpty) {
                data.dataTransfer.setData('text/html', this.editor.data.htmlProcessor.toData(data.content));
                data.dataTransfer.setData('text/plain', viewToPlainText(data.content));
            }
            if (data.method == 'cut') {
                editor.model.deleteContent(modelDocument.selection);
            }
        }, { priority: 'low' });
    }
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/lineview
 */
/* istanbul ignore file -- @preserve */
const toPx = toUnit('px');
/**
 * The horizontal drop target line view.
 */
class LineView extends View {
    /**
     * @inheritDoc
     */
    constructor() {
        super();
        const bind = this.bindTemplate;
        this.set({
            isVisible: false,
            left: null,
            top: null,
            width: null
        });
        this.setTemplate({
            tag: 'div',
            attributes: {
                class: [
                    'ck',
                    'ck-clipboard-drop-target-line',
                    bind.if('isVisible', 'ck-hidden', value => !value)
                ],
                style: {
                    left: bind.to('left', left => toPx(left)),
                    top: bind.to('top', top => toPx(top)),
                    width: bind.to('width', width => toPx(width))
                }
            }
        });
    }
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/dragdroptarget
 */
/**
 * Part of the Drag and Drop handling. Responsible for finding and displaying the drop target.
 *
 * @internal
 */
class DragDropTarget extends Plugin {
    constructor() {
        super(...arguments);
        /**
         * A delayed callback removing the drop marker.
         *
         * @internal
         */
        this.removeDropMarkerDelayed = delay(() => this.removeDropMarker(), 40);
        /**
         * A throttled callback updating the drop marker.
         */
        this._updateDropMarkerThrottled = throttle(targetRange => this._updateDropMarker(targetRange), 40);
        /**
         * A throttled callback reconverting the drop parker.
         */
        this._reconvertMarkerThrottled = throttle(() => {
            if (this.editor.model.markers.has('drop-target')) {
                this.editor.editing.reconvertMarker('drop-target');
            }
        }, 0);
        /**
         * The horizontal drop target line view.
         */
        this._dropTargetLineView = new LineView();
        /**
         * DOM Emitter.
         */
        this._domEmitter = new (DomEmitterMixin())();
        /**
         * Map of document scrollable elements.
         */
        this._scrollables = new Map();
    }
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'DragDropTarget';
    }
    /**
     * @inheritDoc
     */
    init() {
        this._setupDropMarker();
    }
    /**
     * @inheritDoc
     */
    destroy() {
        this._domEmitter.stopListening();
        for (const { resizeObserver } of this._scrollables.values()) {
            resizeObserver.destroy();
        }
        this._updateDropMarkerThrottled.cancel();
        this.removeDropMarkerDelayed.cancel();
        this._reconvertMarkerThrottled.cancel();
        return super.destroy();
    }
    /**
     * Finds the drop target range and updates the drop marker.
     *
     * @internal
     */
    updateDropMarker(targetViewElement, targetViewRanges, clientX, clientY, blockMode, draggedRange) {
        this.removeDropMarkerDelayed.cancel();
        const targetRange = findDropTargetRange(this.editor, targetViewElement, targetViewRanges, clientX, clientY, blockMode, draggedRange);
        /* istanbul ignore next -- @preserve */
        if (!targetRange) {
            return;
        }
        if (draggedRange && draggedRange.containsRange(targetRange)) {
            // Target range is inside the dragged range.
            return this.removeDropMarker();
        }
        this._updateDropMarkerThrottled(targetRange);
    }
    /**
     * Finds the final drop target range.
     *
     * @internal
     */
    getFinalDropRange(targetViewElement, targetViewRanges, clientX, clientY, blockMode, draggedRange) {
        const targetRange = findDropTargetRange(this.editor, targetViewElement, targetViewRanges, clientX, clientY, blockMode, draggedRange);
        // The dragging markers must be removed after searching for the target range because sometimes
        // the target lands on the marker itself.
        this.removeDropMarker();
        return targetRange;
    }
    /**
     * Removes the drop target marker.
     *
     * @internal
     */
    removeDropMarker() {
        const model = this.editor.model;
        this.removeDropMarkerDelayed.cancel();
        this._updateDropMarkerThrottled.cancel();
        this._dropTargetLineView.isVisible = false;
        if (model.markers.has('drop-target')) {
            model.change(writer => {
                writer.removeMarker('drop-target');
            });
        }
    }
    /**
     * Creates downcast conversion for the drop target marker.
     */
    _setupDropMarker() {
        const editor = this.editor;
        editor.ui.view.body.add(this._dropTargetLineView);
        // Drop marker conversion for hovering over widgets.
        editor.conversion.for('editingDowncast').markerToHighlight({
            model: 'drop-target',
            view: {
                classes: ['ck-clipboard-drop-target-range']
            }
        });
        // Drop marker conversion for in text and block drop target.
        editor.conversion.for('editingDowncast').markerToElement({
            model: 'drop-target',
            view: (data, { writer }) => {
                // Inline drop.
                if (editor.model.schema.checkChild(data.markerRange.start, '$text')) {
                    this._dropTargetLineView.isVisible = false;
                    return this._createDropTargetPosition(writer);
                }
                // Block drop.
                else {
                    if (data.markerRange.isCollapsed) {
                        this._updateDropTargetLine(data.markerRange);
                    }
                    else {
                        this._dropTargetLineView.isVisible = false;
                    }
                }
            }
        });
    }
    /**
     * Updates the drop target marker to the provided range.
     *
     * @param targetRange The range to set the marker to.
     */
    _updateDropMarker(targetRange) {
        const editor = this.editor;
        const markers = editor.model.markers;
        editor.model.change(writer => {
            if (markers.has('drop-target')) {
                if (!markers.get('drop-target').getRange().isEqual(targetRange)) {
                    writer.updateMarker('drop-target', { range: targetRange });
                }
            }
            else {
                writer.addMarker('drop-target', {
                    range: targetRange,
                    usingOperation: false,
                    affectsData: false
                });
            }
        });
    }
    /**
     * Creates the UI element for vertical (in-line) drop target.
     */
    _createDropTargetPosition(writer) {
        return writer.createUIElement('span', { class: 'ck ck-clipboard-drop-target-position' }, function (domDocument) {
            const domElement = this.toDomElement(domDocument);
            // Using word joiner to make this marker as high as text and also making text not break on marker.
            domElement.append('\u2060', domDocument.createElement('span'), '\u2060');
            return domElement;
        });
    }
    /**
     * Updates the horizontal drop target line.
     */
    _updateDropTargetLine(range) {
        const editing = this.editor.editing;
        const nodeBefore = range.start.nodeBefore;
        const nodeAfter = range.start.nodeAfter;
        const nodeParent = range.start.parent;
        const viewElementBefore = nodeBefore ? editing.mapper.toViewElement(nodeBefore) : null;
        const domElementBefore = viewElementBefore ? editing.view.domConverter.mapViewToDom(viewElementBefore) : null;
        const viewElementAfter = nodeAfter ? editing.mapper.toViewElement(nodeAfter) : null;
        const domElementAfter = viewElementAfter ? editing.view.domConverter.mapViewToDom(viewElementAfter) : null;
        const viewElementParent = editing.mapper.toViewElement(nodeParent);
        const domElementParent = editing.view.domConverter.mapViewToDom(viewElementParent);
        const domScrollableRect = this._getScrollableRect(viewElementParent);
        const { scrollX, scrollY } = global.window;
        const rectBefore = domElementBefore ? new Rect(domElementBefore) : null;
        const rectAfter = domElementAfter ? new Rect(domElementAfter) : null;
        const rectParent = new Rect(domElementParent).excludeScrollbarsAndBorders();
        const above = rectBefore ? rectBefore.bottom : rectParent.top;
        const below = rectAfter ? rectAfter.top : rectParent.bottom;
        const parentStyle = global.window.getComputedStyle(domElementParent);
        const top = (above <= below ? (above + below) / 2 : below);
        if (domScrollableRect.top < top && top < domScrollableRect.bottom) {
            const left = rectParent.left + parseFloat(parentStyle.paddingLeft);
            const right = rectParent.right - parseFloat(parentStyle.paddingRight);
            const leftClamped = Math.max(left + scrollX, domScrollableRect.left);
            const rightClamped = Math.min(right + scrollX, domScrollableRect.right);
            this._dropTargetLineView.set({
                isVisible: true,
                left: leftClamped,
                top: top + scrollY,
                width: rightClamped - leftClamped
            });
        }
        else {
            this._dropTargetLineView.isVisible = false;
        }
    }
    /**
     * Finds the closest scrollable element rect for the given view element.
     */
    _getScrollableRect(viewElement) {
        const rootName = viewElement.root.rootName;
        let domScrollable;
        if (this._scrollables.has(rootName)) {
            domScrollable = this._scrollables.get(rootName).domElement;
        }
        else {
            const domElement = this.editor.editing.view.domConverter.mapViewToDom(viewElement);
            domScrollable = findScrollableElement(domElement);
            this._domEmitter.listenTo(domScrollable, 'scroll', this._reconvertMarkerThrottled, { usePassive: true });
            const resizeObserver = new ResizeObserver(domScrollable, this._reconvertMarkerThrottled);
            this._scrollables.set(rootName, {
                domElement: domScrollable,
                resizeObserver
            });
        }
        return new Rect(domScrollable).excludeScrollbarsAndBorders();
    }
}
/**
 * Returns fixed selection range for given position and target element.
 */
function findDropTargetRange(editor, targetViewElement, targetViewRanges, clientX, clientY, blockMode, draggedRange) {
    const model = editor.model;
    const mapper = editor.editing.mapper;
    const targetModelElement = getClosestMappedModelElement(editor, targetViewElement);
    let modelElement = targetModelElement;
    while (modelElement) {
        if (!blockMode) {
            if (model.schema.checkChild(modelElement, '$text')) {
                if (targetViewRanges) {
                    const targetViewPosition = targetViewRanges[0].start;
                    const targetModelPosition = mapper.toModelPosition(targetViewPosition);
                    const canDropOnPosition = !draggedRange || Array
                        .from(draggedRange.getItems())
                        .every(item => model.schema.checkChild(targetModelPosition, item));
                    if (canDropOnPosition) {
                        if (model.schema.checkChild(targetModelPosition, '$text')) {
                            return model.createRange(targetModelPosition);
                        }
                        else if (targetViewPosition) {
                            // This is the case of dropping inside a span wrapper of an inline image.
                            return findDropTargetRangeForElement(editor, getClosestMappedModelElement(editor, targetViewPosition.parent), clientX, clientY);
                        }
                    }
                }
            }
            else if (model.schema.isInline(modelElement)) {
                return findDropTargetRangeForElement(editor, modelElement, clientX, clientY);
            }
        }
        if (model.schema.isBlock(modelElement)) {
            return findDropTargetRangeForElement(editor, modelElement, clientX, clientY);
        }
        else if (model.schema.checkChild(modelElement, '$block')) {
            const childNodes = Array.from(modelElement.getChildren())
                .filter((node) => node.is('element') && !isFloatingElement(editor, node));
            let startIndex = 0;
            let endIndex = childNodes.length;
            if (endIndex == 0) {
                return model.createRange(model.createPositionAt(modelElement, 'end'));
            }
            while (startIndex < endIndex - 1) {
                const middleIndex = Math.floor((startIndex + endIndex) / 2);
                const side = findElementSide(editor, childNodes[middleIndex], clientX, clientY);
                if (side == 'before') {
                    endIndex = middleIndex;
                }
                else {
                    startIndex = middleIndex;
                }
            }
            return findDropTargetRangeForElement(editor, childNodes[startIndex], clientX, clientY);
        }
        modelElement = modelElement.parent;
    }
    return null;
}
/**
 * Returns true for elements with floating style set.
 */
function isFloatingElement(editor, modelElement) {
    const mapper = editor.editing.mapper;
    const domConverter = editor.editing.view.domConverter;
    const viewElement = mapper.toViewElement(modelElement);
    const domElement = domConverter.mapViewToDom(viewElement);
    return global.window.getComputedStyle(domElement).float != 'none';
}
/**
 * Returns target range relative to the given element.
 */
function findDropTargetRangeForElement(editor, modelElement, clientX, clientY) {
    const model = editor.model;
    return model.createRange(model.createPositionAt(modelElement, findElementSide(editor, modelElement, clientX, clientY)));
}
/**
 * Resolves whether drop marker should be before or after the given element.
 */
function findElementSide(editor, modelElement, clientX, clientY) {
    const mapper = editor.editing.mapper;
    const domConverter = editor.editing.view.domConverter;
    const viewElement = mapper.toViewElement(modelElement);
    const domElement = domConverter.mapViewToDom(viewElement);
    const rect = new Rect(domElement);
    if (editor.model.schema.isInline(modelElement)) {
        return clientX < (rect.left + rect.right) / 2 ? 'before' : 'after';
    }
    else {
        return clientY < (rect.top + rect.bottom) / 2 ? 'before' : 'after';
    }
}
/**
 * Returns the closest model element for the specified view element.
 */
function getClosestMappedModelElement(editor, element) {
    const mapper = editor.editing.mapper;
    const view = editor.editing.view;
    const targetModelElement = mapper.toModelElement(element);
    if (targetModelElement) {
        return targetModelElement;
    }
    // Find mapped ancestor if the target is inside not mapped element (for example inline code element).
    const viewPosition = view.createPositionBefore(element);
    const viewElement = mapper.findMappedViewAncestor(viewPosition);
    return mapper.toModelElement(viewElement);
}
/**
 * Returns the closest scrollable ancestor DOM element.
 *
 * It is assumed that `domNode` is attached to the document.
 */
function findScrollableElement(domNode) {
    let domElement = domNode;
    do {
        domElement = domElement.parentElement;
        const overflow = global.window.getComputedStyle(domElement).overflowY;
        if (overflow == 'auto' || overflow == 'scroll') {
            break;
        }
    } while (domElement.tagName != 'BODY');
    return domElement;
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/dragdropblocktoolbar
 */
/**
 * Integration of a block Drag and Drop support with the block toolbar.
 *
 * @internal
 */
class DragDropBlockToolbar extends Plugin {
    constructor() {
        super(...arguments);
        /**
         * Whether current dragging is started by block toolbar button dragging.
         */
        this._isBlockDragging = false;
        /**
         * DOM Emitter.
         */
        this._domEmitter = new (DomEmitterMixin())();
    }
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'DragDropBlockToolbar';
    }
    /**
     * @inheritDoc
     */
    init() {
        const editor = this.editor;
        this.listenTo(editor, 'change:isReadOnly', (evt, name, isReadOnly) => {
            if (isReadOnly) {
                this.forceDisabled('readOnlyMode');
                this._isBlockDragging = false;
            }
            else {
                this.clearForceDisabled('readOnlyMode');
            }
        });
        if (env.isAndroid) {
            this.forceDisabled('noAndroidSupport');
        }
        if (editor.plugins.has('BlockToolbar')) {
            const blockToolbar = editor.plugins.get('BlockToolbar');
            const element = blockToolbar.buttonView.element;
            this._domEmitter.listenTo(element, 'dragstart', (evt, data) => this._handleBlockDragStart(data));
            this._domEmitter.listenTo(global.document, 'dragover', (evt, data) => this._handleBlockDragging(data));
            this._domEmitter.listenTo(global.document, 'drop', (evt, data) => this._handleBlockDragging(data));
            this._domEmitter.listenTo(global.document, 'dragend', () => this._handleBlockDragEnd(), { useCapture: true });
            if (this.isEnabled) {
                element.setAttribute('draggable', 'true');
            }
            this.on('change:isEnabled', (evt, name, isEnabled) => {
                element.setAttribute('draggable', isEnabled ? 'true' : 'false');
            });
        }
    }
    /**
     * @inheritDoc
     */
    destroy() {
        this._domEmitter.stopListening();
        return super.destroy();
    }
    /**
     * The `dragstart` event handler.
     */
    _handleBlockDragStart(domEvent) {
        if (!this.isEnabled) {
            return;
        }
        const model = this.editor.model;
        const selection = model.document.selection;
        const view = this.editor.editing.view;
        const blocks = Array.from(selection.getSelectedBlocks());
        const draggedRange = model.createRange(model.createPositionBefore(blocks[0]), model.createPositionAfter(blocks[blocks.length - 1]));
        model.change(writer => writer.setSelection(draggedRange));
        this._isBlockDragging = true;
        view.focus();
        view.getObserver(ClipboardObserver).onDomEvent(domEvent);
    }
    /**
     * The `dragover` and `drop` event handler.
     */
    _handleBlockDragging(domEvent) {
        if (!this.isEnabled || !this._isBlockDragging) {
            return;
        }
        const clientX = domEvent.clientX + (this.editor.locale.contentLanguageDirection == 'ltr' ? 100 : -100);
        const clientY = domEvent.clientY;
        const target = document.elementFromPoint(clientX, clientY);
        const view = this.editor.editing.view;
        if (!target || !target.closest('.ck-editor__editable')) {
            return;
        }
        view.getObserver(ClipboardObserver).onDomEvent({
            ...domEvent,
            type: domEvent.type,
            dataTransfer: domEvent.dataTransfer,
            target,
            clientX,
            clientY,
            preventDefault: () => domEvent.preventDefault(),
            stopPropagation: () => domEvent.stopPropagation()
        });
    }
    /**
     * The `dragend` event handler.
     */
    _handleBlockDragEnd() {
        this._isBlockDragging = false;
    }
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/dragdrop
 */
// Drag and drop events overview:
//
//                ┌──────────────────┐
//                │     mousedown    │   Sets the draggable attribute.
//                └─────────┬────────┘
//                          │
//                          └─────────────────────┐
//                          │                     │
//                          │           ┌─────────V────────┐
//                          │           │      mouseup     │   Dragging did not start, removes the draggable attribute.
//                          │           └──────────────────┘
//                          │
//                ┌─────────V────────┐   Retrieves the selected model.DocumentFragment
//                │     dragstart    │   and converts it to view.DocumentFragment.
//                └─────────┬────────┘
//                          │
//                ┌─────────V────────┐   Processes view.DocumentFragment to text/html and text/plain
//                │  clipboardOutput │   and stores the results in data.dataTransfer.
//                └─────────┬────────┘
//                          │
//                          │   DOM dragover
//                          ┌────────────┐
//                          │            │
//                ┌─────────V────────┐   │
//                │     dragging     │   │   Updates the drop target marker.
//                └─────────┬────────┘   │
//                          │            │
//            ┌─────────────└────────────┘
//            │             │            │
//            │   ┌─────────V────────┐   │
//            │   │     dragleave    │   │   Removes the drop target marker.
//            │   └─────────┬────────┘   │
//            │             │            │
//        ┌───│─────────────┘            │
//        │   │             │            │
//        │   │   ┌─────────V────────┐   │
//        │   │   │     dragenter    │   │   Focuses the editor view.
//        │   │   └─────────┬────────┘   │
//        │   │             │            │
//        │   │             └────────────┘
//        │   │
//        │   └─────────────┐
//        │   │             │
//        │   │   ┌─────────V────────┐
//        └───┐   │       drop       │   (The default handler of the clipboard pipeline).
//            │   └─────────┬────────┘
//            │             │
//            │   ┌─────────V────────┐   Resolves the final data.targetRanges.
//            │   │  clipboardInput  │   Aborts if dropping on dragged content.
//            │   └─────────┬────────┘
//            │             │
//            │   ┌─────────V────────┐
//            │   │  clipboardInput  │   (The default handler of the clipboard pipeline).
//            │   └─────────┬────────┘
//            │             │
//            │ ┌───────────V───────────┐
//            │ │  inputTransformation  │   (The default handler of the clipboard pipeline).
//            │ └───────────┬───────────┘
//            │             │
//            │  ┌──────────V──────────┐
//            │  │   contentInsertion  │   Updates the document selection to drop range.
//            │  └──────────┬──────────┘
//            │             │
//            │  ┌──────────V──────────┐
//            │  │   contentInsertion  │   (The default handler of the clipboard pipeline).
//            │  └──────────┬──────────┘
//            │             │
//            │  ┌──────────V──────────┐
//            │  │   contentInsertion  │   Removes the content from the original range if the insertion was successful.
//            │  └──────────┬──────────┘
//            │             │
//            └─────────────┐
//                          │
//                ┌─────────V────────┐
//                │      dragend     │   Removes the drop marker and cleans the state.
//                └──────────────────┘
//
/**
 * The drag and drop feature. It works on top of the {@link module:clipboard/clipboardpipeline~ClipboardPipeline}.
 *
 * Read more about the clipboard integration in the {@glink framework/deep-dive/clipboard clipboard deep-dive} guide.
 *
 * @internal
 */
class DragDrop extends Plugin {
    constructor() {
        super(...arguments);
        /**
         * A delayed callback removing draggable attributes.
         */
        this._clearDraggableAttributesDelayed = delay(() => this._clearDraggableAttributes(), 40);
        /**
         * Whether the dragged content can be dropped only in block context.
         */
        // TODO handle drag from other editor instance
        // TODO configure to use block, inline or both
        this._blockMode = false;
        /**
         * DOM Emitter.
         */
        this._domEmitter = new (DomEmitterMixin())();
    }
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'DragDrop';
    }
    /**
     * @inheritDoc
     */
    static get requires() {
        return [ClipboardPipeline, Widget, DragDropTarget, DragDropBlockToolbar];
    }
    /**
     * @inheritDoc
     */
    init() {
        const editor = this.editor;
        const view = editor.editing.view;
        this._draggedRange = null;
        this._draggingUid = '';
        this._draggableElement = null;
        view.addObserver(ClipboardObserver);
        view.addObserver(MouseObserver);
        this._setupDragging();
        this._setupContentInsertionIntegration();
        this._setupClipboardInputIntegration();
        this._setupDraggableAttributeHandling();
        this.listenTo(editor, 'change:isReadOnly', (evt, name, isReadOnly) => {
            if (isReadOnly) {
                this.forceDisabled('readOnlyMode');
            }
            else {
                this.clearForceDisabled('readOnlyMode');
            }
        });
        this.on('change:isEnabled', (evt, name, isEnabled) => {
            if (!isEnabled) {
                this._finalizeDragging(false);
            }
        });
        if (env.isAndroid) {
            this.forceDisabled('noAndroidSupport');
        }
    }
    /**
     * @inheritDoc
     */
    destroy() {
        if (this._draggedRange) {
            this._draggedRange.detach();
            this._draggedRange = null;
        }
        if (this._previewContainer) {
            this._previewContainer.remove();
        }
        this._domEmitter.stopListening();
        this._clearDraggableAttributesDelayed.cancel();
        return super.destroy();
    }
    /**
     * Drag and drop events handling.
     */
    _setupDragging() {
        const editor = this.editor;
        const model = editor.model;
        const view = editor.editing.view;
        const viewDocument = view.document;
        const dragDropTarget = editor.plugins.get(DragDropTarget);
        // The handler for the drag start; it is responsible for setting data transfer object.
        this.listenTo(viewDocument, 'dragstart', (evt, data) => {
            // Don't drag the editable element itself.
            if (data.target && data.target.is('editableElement')) {
                data.preventDefault();
                return;
            }
            this._prepareDraggedRange(data.target);
            if (!this._draggedRange) {
                data.preventDefault();
                return;
            }
            this._draggingUid = uid();
            data.dataTransfer.effectAllowed = this.isEnabled ? 'copyMove' : 'copy';
            data.dataTransfer.setData('application/ckeditor5-dragging-uid', this._draggingUid);
            const draggedSelection = model.createSelection(this._draggedRange.toRange());
            const clipboardPipeline = this.editor.plugins.get('ClipboardPipeline');
            clipboardPipeline._fireOutputTransformationEvent(data.dataTransfer, draggedSelection, 'dragstart');
            const { dataTransfer, domTarget, domEvent } = data;
            const { clientX } = domEvent;
            this._updatePreview({ dataTransfer, domTarget, clientX });
            data.stopPropagation();
            if (!this.isEnabled) {
                this._draggedRange.detach();
                this._draggedRange = null;
                this._draggingUid = '';
            }
        }, { priority: 'low' });
        // The handler for finalizing drag and drop. It should always be triggered after dragging completes
        // even if it was completed in a different application.
        // Note: This is not fired if source text node got removed while downcasting a marker.
        this.listenTo(viewDocument, 'dragend', (evt, data) => {
            this._finalizeDragging(!data.dataTransfer.isCanceled && data.dataTransfer.dropEffect == 'move');
        }, { priority: 'low' });
        // Reset block dragging mode even if dropped outside the editable.
        this._domEmitter.listenTo(global.document, 'dragend', () => {
            this._blockMode = false;
        }, { useCapture: true });
        // Dragging over the editable.
        this.listenTo(viewDocument, 'dragenter', () => {
            if (!this.isEnabled) {
                return;
            }
            view.focus();
        });
        // Dragging out of the editable.
        this.listenTo(viewDocument, 'dragleave', () => {
            // We do not know if the mouse left the editor or just some element in it, so let us wait a few milliseconds
            // to check if 'dragover' is not fired.
            dragDropTarget.removeDropMarkerDelayed();
        });
        // Handler for moving dragged content over the target area.
        this.listenTo(viewDocument, 'dragging', (evt, data) => {
            if (!this.isEnabled) {
                data.dataTransfer.dropEffect = 'none';
                return;
            }
            const { clientX, clientY } = data.domEvent;
            dragDropTarget.updateDropMarker(data.target, data.targetRanges, clientX, clientY, this._blockMode, this._draggedRange);
            // If this is content being dragged from another editor, moving out of current editor instance
            // is not possible until 'dragend' event case will be fixed.
            if (!this._draggedRange) {
                data.dataTransfer.dropEffect = 'copy';
            }
            // In Firefox it is already set and effect allowed remains the same as originally set.
            if (!env.isGecko) {
                if (data.dataTransfer.effectAllowed == 'copy') {
                    data.dataTransfer.dropEffect = 'copy';
                }
                else if (['all', 'copyMove'].includes(data.dataTransfer.effectAllowed)) {
                    data.dataTransfer.dropEffect = 'move';
                }
            }
            evt.stop();
        }, { priority: 'low' });
    }
    /**
     * Integration with the `clipboardInput` event.
     */
    _setupClipboardInputIntegration() {
        const editor = this.editor;
        const view = editor.editing.view;
        const viewDocument = view.document;
        const dragDropTarget = editor.plugins.get(DragDropTarget);
        // Update the event target ranges and abort dropping if dropping over itself.
        this.listenTo(viewDocument, 'clipboardInput', (evt, data) => {
            if (data.method != 'drop') {
                return;
            }
            const { clientX, clientY } = data.domEvent;
            const targetRange = dragDropTarget.getFinalDropRange(data.target, data.targetRanges, clientX, clientY, this._blockMode, this._draggedRange);
            if (!targetRange) {
                this._finalizeDragging(false);
                evt.stop();
                return;
            }
            // Since we cannot rely on the drag end event, we must check if the local drag range is from the current drag and drop
            // or it is from some previous not cleared one.
            if (this._draggedRange && this._draggingUid != data.dataTransfer.getData('application/ckeditor5-dragging-uid')) {
                this._draggedRange.detach();
                this._draggedRange = null;
                this._draggingUid = '';
            }
            // Do not do anything if some content was dragged within the same document to the same position.
            const isMove = getFinalDropEffect(data.dataTransfer) == 'move';
            if (isMove && this._draggedRange && this._draggedRange.containsRange(targetRange, true)) {
                this._finalizeDragging(false);
                evt.stop();
                return;
            }
            // Override the target ranges with the one adjusted to the best one for a drop.
            data.targetRanges = [editor.editing.mapper.toViewRange(targetRange)];
        }, { priority: 'high' });
    }
    /**
     * Integration with the `contentInsertion` event of the clipboard pipeline.
     */
    _setupContentInsertionIntegration() {
        const clipboardPipeline = this.editor.plugins.get(ClipboardPipeline);
        clipboardPipeline.on('contentInsertion', (evt, data) => {
            if (!this.isEnabled || data.method !== 'drop') {
                return;
            }
            // Update the selection to the target range in the same change block to avoid selection post-fixing
            // and to be able to clone text attributes for plain text dropping.
            const ranges = data.targetRanges.map(viewRange => this.editor.editing.mapper.toModelRange(viewRange));
            this.editor.model.change(writer => writer.setSelection(ranges));
        }, { priority: 'high' });
        clipboardPipeline.on('contentInsertion', (evt, data) => {
            if (!this.isEnabled || data.method !== 'drop') {
                return;
            }
            // Remove dragged range content, remove markers, clean after dragging.
            const isMove = getFinalDropEffect(data.dataTransfer) == 'move';
            // Whether any content was inserted (insertion might fail if the schema is disallowing some elements
            // (for example an image caption allows only the content of a block but not blocks themselves.
            // Some integrations might not return valid range (i.e., table pasting).
            const isSuccess = !data.resultRange || !data.resultRange.isCollapsed;
            this._finalizeDragging(isSuccess && isMove);
        }, { priority: 'lowest' });
    }
    /**
     * Adds listeners that add the `draggable` attribute to the elements while the mouse button is down so the dragging could start.
     */
    _setupDraggableAttributeHandling() {
        const editor = this.editor;
        const view = editor.editing.view;
        const viewDocument = view.document;
        // Add the 'draggable' attribute to the widget while pressing the selection handle.
        // This is required for widgets to be draggable. In Chrome it will enable dragging text nodes.
        this.listenTo(viewDocument, 'mousedown', (evt, data) => {
            // The lack of data can be caused by editor tests firing fake mouse events. This should not occur
            // in real-life scenarios but this greatly simplifies editor tests that would otherwise fail a lot.
            if (env.isAndroid || !data) {
                return;
            }
            this._clearDraggableAttributesDelayed.cancel();
            // Check if this is a mousedown over the widget (but not a nested editable).
            let draggableElement = findDraggableWidget(data.target);
            // Note: There is a limitation that if more than a widget is selected (a widget and some text)
            // and dragging starts on the widget, then only the widget is dragged.
            // If this was not a widget then we should check if we need to drag some text content.
            // In Chrome set a 'draggable' attribute on closest editable to allow immediate dragging of the selected text range.
            // In Firefox this is not needed. In Safari it makes the whole editable draggable (not just textual content).
            // Disabled in read-only mode because draggable="true" + contenteditable="false" results
            // in not firing selectionchange event ever, which makes the selection stuck in read-only mode.
            if (env.isBlink && !editor.isReadOnly && !draggableElement && !viewDocument.selection.isCollapsed) {
                const selectedElement = viewDocument.selection.getSelectedElement();
                if (!selectedElement || !isWidget(selectedElement)) {
                    draggableElement = viewDocument.selection.editableElement;
                }
            }
            if (draggableElement) {
                view.change(writer => {
                    writer.setAttribute('draggable', 'true', draggableElement);
                });
                // Keep the reference to the model element in case the view element gets removed while dragging.
                this._draggableElement = editor.editing.mapper.toModelElement(draggableElement);
            }
        });
        // Remove the draggable attribute in case no dragging started (only mousedown + mouseup).
        this.listenTo(viewDocument, 'mouseup', () => {
            if (!env.isAndroid) {
                this._clearDraggableAttributesDelayed();
            }
        });
    }
    /**
     * Removes the `draggable` attribute from the element that was used for dragging.
     */
    _clearDraggableAttributes() {
        const editing = this.editor.editing;
        editing.view.change(writer => {
            // Remove 'draggable' attribute.
            if (this._draggableElement && this._draggableElement.root.rootName != '$graveyard') {
                writer.removeAttribute('draggable', editing.mapper.toViewElement(this._draggableElement));
            }
            this._draggableElement = null;
        });
    }
    /**
     * Deletes the dragged content from its original range and clears the dragging state.
     *
     * @param moved Whether the move succeeded.
     */
    _finalizeDragging(moved) {
        const editor = this.editor;
        const model = editor.model;
        const dragDropTarget = editor.plugins.get(DragDropTarget);
        dragDropTarget.removeDropMarker();
        this._clearDraggableAttributes();
        if (editor.plugins.has('WidgetToolbarRepository')) {
            const widgetToolbarRepository = editor.plugins.get('WidgetToolbarRepository');
            widgetToolbarRepository.clearForceDisabled('dragDrop');
        }
        this._draggingUid = '';
        if (this._previewContainer) {
            this._previewContainer.remove();
            this._previewContainer = undefined;
        }
        if (!this._draggedRange) {
            return;
        }
        // Delete moved content.
        if (moved && this.isEnabled) {
            model.change(writer => {
                const selection = model.createSelection(this._draggedRange);
                model.deleteContent(selection, { doNotAutoparagraph: true });
                // Check result selection if it does not require auto-paragraphing of empty container.
                const selectionParent = selection.getFirstPosition().parent;
                if (selectionParent.isEmpty &&
                    !model.schema.checkChild(selectionParent, '$text') &&
                    model.schema.checkChild(selectionParent, 'paragraph')) {
                    writer.insertElement('paragraph', selectionParent, 0);
                }
            });
        }
        this._draggedRange.detach();
        this._draggedRange = null;
    }
    /**
     * Sets the dragged source range based on event target and document selection.
     */
    _prepareDraggedRange(target) {
        const editor = this.editor;
        const model = editor.model;
        const selection = model.document.selection;
        // Check if this is dragstart over the widget (but not a nested editable).
        const draggableWidget = target ? findDraggableWidget(target) : null;
        if (draggableWidget) {
            const modelElement = editor.editing.mapper.toModelElement(draggableWidget);
            this._draggedRange = LiveRange.fromRange(model.createRangeOn(modelElement));
            this._blockMode = model.schema.isBlock(modelElement);
            // Disable toolbars so they won't obscure the drop area.
            if (editor.plugins.has('WidgetToolbarRepository')) {
                const widgetToolbarRepository = editor.plugins.get('WidgetToolbarRepository');
                widgetToolbarRepository.forceDisabled('dragDrop');
            }
            return;
        }
        // If this was not a widget we should check if we need to drag some text content.
        if (selection.isCollapsed && !selection.getFirstPosition().parent.isEmpty) {
            return;
        }
        const blocks = Array.from(selection.getSelectedBlocks());
        const draggedRange = selection.getFirstRange();
        if (blocks.length == 0) {
            this._draggedRange = LiveRange.fromRange(draggedRange);
            return;
        }
        const blockRange = getRangeIncludingFullySelectedParents(model, blocks);
        if (blocks.length > 1) {
            this._draggedRange = LiveRange.fromRange(blockRange);
            this._blockMode = true;
            // TODO block mode for dragging from outside editor? or inline? or both?
        }
        else if (blocks.length == 1) {
            const touchesBlockEdges = draggedRange.start.isTouching(blockRange.start) &&
                draggedRange.end.isTouching(blockRange.end);
            this._draggedRange = LiveRange.fromRange(touchesBlockEdges ? blockRange : draggedRange);
            this._blockMode = touchesBlockEdges;
        }
        model.change(writer => writer.setSelection(this._draggedRange.toRange()));
    }
    /**
     * Updates the dragged preview image.
     */
    _updatePreview({ dataTransfer, domTarget, clientX }) {
        const view = this.editor.editing.view;
        const editable = view.document.selection.editableElement;
        const domEditable = view.domConverter.mapViewToDom(editable);
        const computedStyle = global.window.getComputedStyle(domEditable);
        if (!this._previewContainer) {
            this._previewContainer = createElement(global.document, 'div', {
                style: 'position: fixed; left: -999999px;'
            });
            global.document.body.appendChild(this._previewContainer);
        }
        else if (this._previewContainer.firstElementChild) {
            this._previewContainer.removeChild(this._previewContainer.firstElementChild);
        }
        const domRect = new Rect(domEditable);
        // If domTarget is inside the editable root, browsers will display the preview correctly by themselves.
        if (domEditable.contains(domTarget)) {
            return;
        }
        const domEditablePaddingLeft = parseFloat(computedStyle.paddingLeft);
        const preview = createElement(global.document, 'div');
        preview.className = 'ck ck-content';
        preview.style.width = computedStyle.width;
        preview.style.paddingLeft = `${domRect.left - clientX + domEditablePaddingLeft}px`;
        /**
         * Set white background in drag and drop preview if iOS.
         * Check: https://github.com/ckeditor/ckeditor5/issues/15085
         */
        if (env.isiOS) {
            preview.style.backgroundColor = 'white';
        }
        preview.innerHTML = dataTransfer.getData('text/html');
        dataTransfer.setDragImage(preview, 0, 0);
        this._previewContainer.appendChild(preview);
    }
}
/**
 * Returns the drop effect that should be a result of dragging the content.
 * This function is handling a quirk when checking the effect in the 'drop' DOM event.
 */
function getFinalDropEffect(dataTransfer) {
    if (env.isGecko) {
        return dataTransfer.dropEffect;
    }
    return ['all', 'copyMove'].includes(dataTransfer.effectAllowed) ? 'move' : 'copy';
}
/**
 * Returns a widget element that should be dragged.
 */
function findDraggableWidget(target) {
    // This is directly an editable so not a widget for sure.
    if (target.is('editableElement')) {
        return null;
    }
    // TODO: Let's have a isWidgetSelectionHandleDomElement() helper in ckeditor5-widget utils.
    if (target.hasClass('ck-widget__selection-handle')) {
        return target.findAncestor(isWidget);
    }
    // Direct hit on a widget.
    if (isWidget(target)) {
        return target;
    }
    // Find closest ancestor that is either a widget or an editable element...
    const ancestor = target.findAncestor(node => isWidget(node) || node.is('editableElement'));
    // ...and if closer was the widget then enable dragging it.
    if (isWidget(ancestor)) {
        return ancestor;
    }
    return null;
}
/**
 * Recursively checks if common parent of provided elements doesn't have any other children. If that's the case,
 * it returns range including this parent. Otherwise, it returns only the range from first to last element.
 *
 * Example:
 *
 * <blockQuote>
 *   <paragraph>[Test 1</paragraph>
 *   <paragraph>Test 2</paragraph>
 *   <paragraph>Test 3]</paragraph>
 * <blockQuote>
 *
 * Because all elements inside the `blockQuote` are selected, the range is extended to include the `blockQuote` too.
 * If only first and second paragraphs would be selected, the range would not include it.
 */
function getRangeIncludingFullySelectedParents(model, elements) {
    const firstElement = elements[0];
    const lastElement = elements[elements.length - 1];
    const parent = firstElement.getCommonAncestor(lastElement);
    const startPosition = model.createPositionBefore(firstElement);
    const endPosition = model.createPositionAfter(lastElement);
    if (parent &&
        parent.is('element') &&
        !model.schema.isLimit(parent)) {
        const parentRange = model.createRangeOn(parent);
        const touchesStart = startPosition.isTouching(parentRange.start);
        const touchesEnd = endPosition.isTouching(parentRange.end);
        if (touchesStart && touchesEnd) {
            // Selection includes all elements in the parent.
            return getRangeIncludingFullySelectedParents(model, [parent]);
        }
    }
    return model.createRange(startPosition, endPosition);
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/pasteplaintext
 */
/**
 * The plugin detects the user's intention to paste plain text.
 *
 * For example, it detects the <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> keystroke.
 */
class PastePlainText extends Plugin {
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'PastePlainText';
    }
    /**
     * @inheritDoc
     */
    static get requires() {
        return [ClipboardPipeline];
    }
    /**
     * @inheritDoc
     */
    init() {
        const editor = this.editor;
        const model = editor.model;
        const view = editor.editing.view;
        const viewDocument = view.document;
        const selection = model.document.selection;
        let shiftPressed = false;
        view.addObserver(ClipboardObserver);
        this.listenTo(viewDocument, 'keydown', (evt, data) => {
            shiftPressed = data.shiftKey;
        });
        editor.plugins.get(ClipboardPipeline).on('contentInsertion', (evt, data) => {
            // Plain text can be determined based on the event flag (#7799) or auto-detection (#1006). If detected,
            // preserve selection attributes on pasted items.
            if (!shiftPressed && !isPlainTextFragment(data.content, model.schema)) {
                return;
            }
            model.change(writer => {
                // Formatting attributes should be preserved.
                const textAttributes = Array.from(selection.getAttributes())
                    .filter(([key]) => model.schema.getAttributeProperties(key).isFormatting);
                if (!selection.isCollapsed) {
                    model.deleteContent(selection, { doNotAutoparagraph: true });
                }
                // Also preserve other attributes if they survived the content deletion (because they were not fully selected).
                // For example linkHref is not a formatting attribute but it should be preserved if pasted text was in the middle
                // of a link.
                textAttributes.push(...selection.getAttributes());
                const range = writer.createRangeIn(data.content);
                for (const item of range.getItems()) {
                    if (item.is('$textProxy')) {
                        writer.setAttributes(textAttributes, item);
                    }
                }
            });
        });
    }
}
/**
 * Returns true if specified `documentFragment` represents a plain text.
 */
function isPlainTextFragment(documentFragment, schema) {
    if (documentFragment.childCount > 1) {
        return false;
    }
    const child = documentFragment.getChild(0);
    if (schema.isObject(child)) {
        return false;
    }
    return Array.from(child.getAttributeKeys()).length == 0;
}

/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */
/**
 * @module clipboard/clipboard
 */
/**
 * The clipboard feature.
 *
 * Read more about the clipboard integration in the {@glink framework/deep-dive/clipboard clipboard deep-dive} guide.
 *
 * This is a "glue" plugin which loads the following plugins:
 * * {@link module:clipboard/clipboardpipeline~ClipboardPipeline}
 * * {@link module:clipboard/dragdrop~DragDrop}
 * * {@link module:clipboard/pasteplaintext~PastePlainText}
 */
class Clipboard extends Plugin {
    /**
     * @inheritDoc
     */
    static get pluginName() {
        return 'Clipboard';
    }
    /**
     * @inheritDoc
     */
    static get requires() {
        return [ClipboardPipeline, DragDrop, PastePlainText];
    }
}

export { Clipboard, ClipboardPipeline, DragDrop, DragDropBlockToolbar, DragDropTarget, PastePlainText };
