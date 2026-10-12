const fs = require('fs')
const path = require('path')

// Exercise the published example itself so documentation cannot drift from
// the unit and real-mount coverage of its backing-file lifecycle.
module.exports = function passthroughExample ({ Fuse, filesystem = fs, mountpoint, otherOperations, backingPathFor }) {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8')
  const section = readme.split('### Kernel passthrough (Linux)')[1]
  const example = section && section.match(/```js\n([\s\S]*?)\n```/)
  if (!example) throw new Error('The README passthrough example is missing')
  const create = new Function('fs', 'Fuse', 'mountpoint', 'otherOperations', 'backingPathFor', `${example[1]}\nreturn fuse`)
  return create(filesystem, Fuse, mountpoint, otherOperations, backingPathFor)
}
