(typeof define === 'function' && define.amd ? define : /* istanbul ignore next */ function (factory) {
	this.EventProxy = factory();
})(function () {
	var EVENT_TYPES = 'click dblclick mousedown mouseup mousemove keydown keyup'.split(' ');

	function EventProxy(window, document, chrome) {
		this.window = window;
		this.document = document;
		this.chrome = chrome;
		this.lastMouseDown = {};
	}

	EventProxy.prototype = {
		constructor: EventProxy,

		/**
		 * This function will return {path, element} where path is the XPath selection string
		 * and element is the element it identifies. This is usually the element clicked, but can be an ancestor
		 * e.g. if clicking on a span within a link.
		 */
		getTargetInfo: null,

		/** @type {string} optional window property name, custom xpath builder function */
		xpathBuilder: null,

		port: null,

		connect: function () {
			var self = this;
			var sendEvent = function () {
				return self.sendEvent.apply(self, arguments);
			};
			var passEvent = function () {
				return self.passEvent.apply(self, arguments);
			};

			this.window.addEventListener('message', passEvent, false);
			EVENT_TYPES.forEach(function (eventType) {
				self.document.addEventListener(eventType, sendEvent, true);
			});

			if (this.port) {
				this.port.disconnect();
			}

			this.port = this.chrome.runtime.connect(this.chrome.runtime.id, { name: 'eventProxy' });
			this.port.onDisconnect.addListener(function disconnect() {
				self.port.onDisconnect.removeListener(disconnect);
				EVENT_TYPES.forEach(function (eventType) {
					self.document.removeEventListener(eventType, sendEvent, true);
				});
				self.window.removeEventListener('message', passEvent, false);
				self.port = null;
			});
			this.port.onMessage.addListener(function (message) {
				if (!self[message.method]) {
					throw new Error('Method "' + message.method + '" does not exist on RecorderProxy');
				}

				self[message.method].apply(self, message.args || []);
			});
		},

		getElementTextPathInfo: function (element) {
			var tagPrefix = '//' + element.nodeName;

			var textValue = this.document.evaluate(
				'normalize-space(string())',
				element,
				null,
				this.window.XPathResult.STRING_TYPE,
				null
			).stringValue;

			var path = '[normalize-space(string())="' + textValue.replace(/"/g, '&quot;') + '"]';

			var matchingElements = this.document.evaluate(
				tagPrefix + path,
				this.document,
				null,
				this.window.XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
				null
			);

			matchingElements.iterateNext();
			var matchesMultipleElements = Boolean(matchingElements.iterateNext());

			if (matchesMultipleElements) {
				// ignoring IDs because when the text strategy is being used it typically means that IDs are not
				// deterministic
				path = this.getElementXPathInfo(element, true) + path;
			}
			else {
				path = tagPrefix + path;
			}

			return {path: path, element: element};
		},

		getElementXPathInfo: function (element, ignoreId) {
			if (this.xpathBuilder && this.window[this.xpathBuilder]) {
				// Custom function defined
				var func = this.window[this.xpathBuilder];
				for (var ancestor = element; ancestor!==null && ancestor!==this.document; ancestor = ancestor.parentNode) {
					var result = func(ancestor);
					if (result) return {path: result, element: ancestor};
				}
				// Not found. Use body:
				return {path: "//BODY", element: this.document.body};
			}

			var origElem = element;
			var path = [];

			do {
				if (element.id && !ignoreId) {
					path.unshift('id("' + element.id + '")');

					// No need to continue to ascend since we found a unique root
					break;
				}
				else if (element.parentNode) {
					var nodeName = element.nodeName;
					var hasNamedSiblings = Boolean(element.previousElementSibling || element.nextElementSibling);
					// XPath is 1-indexed
					var index = 1;
					var sibling = element;

					if (hasNamedSiblings) {
						while ((sibling = sibling.previousElementSibling)) {
							if (sibling.nodeName === nodeName) {
								++index;
							}
						}

						path.unshift(nodeName + '[' + index + ']');
					}
					else {
						path.unshift(nodeName);
					}
				}
				// The root node
				else {
					path.unshift('');
				}
			} while ((element = element.parentNode));

			return {path: path.join('/'), element: origElem};
		},

		passEvent: function (event) {
			if (!event.data || event.data.method !== 'recordEvent' || !event.data.detail) {
				return;
			}

			var detail = event.data.detail;

			for (var i = 0; i < this.window.frames.length; ++i) {
				if (event.source === this.window.frames[i]) {
					detail.targetFrame.unshift(i);
					break;
				}
			}

			this.send(detail);
		},

		send: function (detail) {
			//if (detail.type!=="mousemove") console.log(detail);
			if (this.window !== this.window.top) {
				this.window.parent.postMessage({
					method: 'recordEvent',
					detail: detail
				}, '*');
			}
			else {
				this.port.postMessage({
					method: 'recordEvent',
					args: [ detail ]
				});
			}
		},

		sendEvent: function (event) {
			if (!this.getTargetInfo) {
				// Attempt to understand and workaround weird failure where in debugger this is a function yet
				// it still crashes with not a function:
				console.log("No getTargetInfo");
				window.setTimeout(sendEvent.bind(this, event), 0);
				return;
			}

			var lastMouseDown = this.lastMouseDown;
			var target;

			function isDragEvent() {
				return Math.abs(event.clientX - lastMouseDown[event.button].event.clientX) > 5 ||
					Math.abs(event.clientY - lastMouseDown[event.button].event.clientY > 5);
			}

			if (event.type === 'click' && isDragEvent()) {
				return;
			}

			if (event.type === 'mousedown') {
				lastMouseDown[event.button] = {
					event: event,
					elements: this.document.elementsFromPoint(event.clientX, event.clientY)
				};
			}

			// When a user drags an element that moves with the mouse, the element will not be dragged in the recorded
			// output unless the final position of the mouse is recorded relative to an element that did not move
			if (event.type === 'mouseup') {
				target = (function () {
					// The nearest element to the target that was not also the nearest element to the source is
					// very likely to be an element that did not move along with the drag
					var sourceElements = lastMouseDown[event.button].elements;
					var targetElements = this.document.elementsFromPoint(event.clientX, event.clientY);
					for (var i = 0; i < sourceElements.length; ++i) {
						if (sourceElements[i] !== targetElements[i]) {
							return targetElements[i];
						}
					}

					// TODO: Using document.body instead of document.documentElement because of
					// https://code.google.com/p/chromedriver/issues/detail?id=1049
					return this.document.body;
				}).call(this);
			}
			else {
				target = event.target;
			}

			var targetInfo = this.getTargetInfo(target);

			var rect = targetInfo.element.getBoundingClientRect();

			this.send({
				altKey: event.altKey,
				button: event.button,
				buttons: event.buttons,
				ctrlKey: event.ctrlKey,
				clientX: event.clientX,
				clientY: event.clientY,
				elementX: event.clientX - rect.left,
				elementY: event.clientY - rect.top,
				keyIdentifier: event.keyIdentifier,
				location: event.location,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				target: targetInfo.path,
				targetFrame: [],
				type: event.type
			});
		},



		setStrategy: function (value) {
			switch (value) {
				case 'xpath':
					this.getTargetInfo = this.getElementXPathInfo;
					break;
				case 'text':
					this.getTargetInfo = this.getElementTextPathInfo;
					break;
				default:
					throw new Error('Invalid strategy "' + value + '"');
			}
		},

		/**
		 * @param {string} value The name of a global function (on window) that, if present, builds the XPath
		 * used to record when you interact with an element. Allows the application under test to produce XPath
		 * that are better (more maintainable, more human readable) than using IDs, text or DOM path.
		 * Applies only when using "xpath" strategy.
         */
		setXPathBuilder: function (value) {
			this.xpathBuilder = value;
		}
	};

	return EventProxy;
});
