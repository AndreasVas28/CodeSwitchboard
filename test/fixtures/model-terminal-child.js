'use strict';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('CHILD_READY\r\n');
let line = '';
process.stdin.on('data', (chunk) => {
  const data = chunk.toString('utf8');
  if (/\x1b\[[0-9;?:> ]*_/.test(data)) process.stdout.write('UNEXPECTED_QUERY_FORWARD\r\n');
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const command = line.replace(/[\x08\x7f]/g, '');
      line = '';
      if (command.startsWith('/model ')) process.stdout.write(`SWITCHED:${command.slice(7)}\r\n`);
    } else if (character === '\x7f' || character === '\b') line = line.slice(0, -1);
    else line += character;
  }
});

