import vm from 'node:vm';

export function runWorker(source, msg, data) {
	let messageHandler = null;
	const messages = [];
	const context = vm.createContext({
		console,
		postMessage(message) { messages.push(message); },
		self: {
			addEventListener(type, handler) {
				if (type === 'message') messageHandler = handler;
			}
		}
	});
	vm.runInContext(source, context, {filename: 'umalator-global/simulator.worker.js'});
	if (messageHandler == null) throw new Error('worker did not register a message handler');
	messageHandler({data: {msg, data}});
	return messages;
}
