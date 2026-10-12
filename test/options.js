const tape = require('tape')
const Fuse = require('../')
const { validateFuse3Options } = require('../lib/fuse3-options')

tape('mount options serialize as single libfuse values', function (t) {
  const fuse = new Fuse('/tmp/fuse-napi-options', {}, {
    uid: 501,
    fsname: 'fuse-napi-test'
  })

  t.equal(
    fuse._fuseOptions(),
    '-ofsname=fuse-napi-test,uid=501',
    'validated values remain individual libfuse options'
  )
  t.end()
})

tape('maxRead serializes as the matching libfuse max_read option', function (t) {
  const fuse = new Fuse('/tmp/fuse-napi-max-read-option', {}, {
    maxRead: 262144
  })

  t.equal(fuse._fuseOptions(), '-omax_read=262144')
  t.end()
})

tape('zero-valued numeric mount options are preserved', function (t) {
  const fuse = new Fuse('/tmp/fuse-napi-zero-options', {}, {
    maxRead: 0,
    autoCache: true,
    umask: 0,
    uid: 0,
    gid: 0,
    entryTimeout: 0,
    attrTimeout: 0,
    acAttrTimeout: 0,
    remember: 0
  })

  t.deepEqual(
    fuse._fuseOptions().slice(2).split(','),
    [
      'max_read=0',
      'auto_cache',
      'umask=0',
      'uid=0',
      'gid=0',
      'entry_timeout=0',
      'attr_timeout=0',
      'ac_attr_timeout=0',
      'remember=0'
    ],
    'explicit zeroes reach libfuse'
  )
  t.end()
})

tape('native libfuse option names are normalized aliases', function (t) {
  const cases = [
    ['allow_other', 'allowOther', true, '-oallow_other'],
    ['allow_root', 'allowRoot', true, '-oallow_root'],
    ['auto_unmount', 'autoUnmount', true, '-oauto_unmount'],
    ['default_permissions', 'defaultPermissions', true, '-odefault_permissions'],
    ['max_read', 'maxRead', 4096, '-omax_read=4096'],
    ['kernel_cache', 'kernelCache', true, '-okernel_cache'],
    ['auto_cache', 'autoCache', true, '-oauto_cache'],
    ['entry_timeout', 'entryTimeout', 1.5, '-oentry_timeout=1.5'],
    ['attr_timeout', 'attrTimeout', 2.5, '-oattr_timeout=2.5'],
    ['direct_io', 'directIo', true, ''],
    ['use_ino', 'useIno', true, ''],
    ['nopath', 'noPath', true, '']
  ]

  for (const [alias, canonical, value, serialized] of cases) {
    const fuse = new Fuse(`/tmp/fuse-napi-option-alias-${alias}`, {}, {
      [alias]: value
    })

    t.equal(fuse.opts[canonical], value, `${alias} is normalized to ${canonical}`)
    t.notOk(
      Object.prototype.hasOwnProperty.call(fuse.opts, alias),
      `${alias} is removed from normalized options`
    )
    t.equal(fuse._fuseOptions(), serialized, `${alias} has canonical behavior`)
  }

  const autoCacheFuse = new Fuse('/tmp/fuse-napi-option-alias-ac_attr_timeout', {}, {
    auto_cache: true,
    ac_attr_timeout: 3.5
  })
  t.equal(autoCacheFuse.opts.acAttrTimeout, 3.5, 'ac_attr_timeout is normalized')
  t.equal(
    autoCacheFuse._fuseOptions(),
    '-oauto_cache,ac_attr_timeout=3.5',
    'ac_attr_timeout is accepted with auto_cache'
  )
  t.end()
})

tape('option aliases reject ambiguity without weakening validation', function (t) {
  t.doesNotThrow(
    () => new Fuse('/tmp/fuse-napi-matching-option-aliases', {}, {
      nonEmpty: false,
      nonempty: false
    }),
    'matching canonical and native names are accepted'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-conflicting-option-aliases', {}, {
      nonEmpty: false,
      nonempty: true
    }),
    /"nonEmpty".*"nonempty".*must not conflict/,
    'conflicting canonical and native names are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-invalid-option-alias', {}, {
      nonempty: 'yes'
    }),
    /nonEmpty must be a boolean/,
    'aliases receive canonical type validation'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-unknown-option-alias', {}, {
      allow_others: true
    }),
    /Unknown FUSE option/,
    'unrecognized spellings remain rejected'
  )
  t.end()
})

tape('mixed application mount configuration remains compatible', function (t) {
  const fuse = new Fuse('/tmp/fuse-napi-mixed-option-names', {}, {
    force: true,
    allowOther: true,
    mkdir: true,
    nonempty: false,
    directIo: true
  })

  t.deepEqual(
    fuse._fuseOptions().slice(2).split(','),
    ['allow_other'],
    'canonical and native names compose without duplicate mount options'
  )
  t.end()
})

tape('invalidateEntry validates virtual paths before native notification', function (t) {
  t.plan(3)
  const fuse = new Fuse('/tmp/fuse-napi-entry-invalidation', {})

  fuse.invalidateEntry('relative', err => {
    t.match(err && err.message, /absolute/, 'relative paths are rejected')
  })
  fuse.invalidateEntry('/', err => {
    t.match(err && err.message, /root entry/, 'the root cannot be invalidated')
  })
  fuse.invalidateEntry('/file', err => {
    t.equal(err && err.code, 'ENOTCONN', 'a detached filesystem fails deterministically')
  })
})

tape('FUSE 3 option conformance failures are deterministic and actionable', function (t) {
  const cases = [
    [{ nonEmpty: true }, 'linux', 'ERR_FUSE_OPTION_REMOVED', ['nonEmpty'], /removed in FUSE 3/],
    [{ fd: 3 }, 'linux', 'ERR_FUSE_OPTION_INTERNAL', ['fd'], /managed internally/],
    [{ userId: 1000 }, 'linux', 'ERR_FUSE_OPTION_INTERNAL', ['userId'], /managed internally/],
    [{ allowOther: true, allowRoot: true }, 'linux', 'ERR_FUSE_OPTION_CONFLICT', ['allowOther', 'allowRoot'], /mutually exclusive/],
    [{ kernelCache: true, autoCache: true }, 'linux', 'ERR_FUSE_OPTION_CONFLICT', ['kernelCache', 'autoCache'], /incompatible cache/],
    [{ directIo: true, kernelCache: true }, 'linux', 'ERR_FUSE_OPTION_CONFLICT', ['directIo', 'kernelCache'], /bypasses the kernel page cache/],
    [{ noforget: true, remember: 0 }, 'linux', 'ERR_FUSE_OPTION_CONFLICT', ['noforget', 'remember'], /mutually exclusive/],
    [{ acAttrTimeout: 1 }, 'linux', 'ERR_FUSE_OPTION_DEPENDENCY', ['acAttrTimeout', 'autoCache'], /only meaningful/],
    [{ blksize: 4096 }, 'darwin', 'ERR_FUSE_OPTION_PLATFORM', ['blksize'], /only by Linux/],
    [{ blksize: 4096 }, 'linux', 'ERR_FUSE_OPTION_DEPENDENCY', ['blksize', 'blkdev'], /only valid.*blkdev/],
    [{ blkdev: true }, 'linux', 'ERR_FUSE_OPTION_DEPENDENCY', ['blkdev', 'fsname'], /requires.*fsname/],
    [{ displayFolder: true }, 'linux', 'ERR_FUSE_OPTION_PLATFORM', ['displayFolder'], /macFUSE-only/],
    [{ name: 'volume' }, 'darwin', 'ERR_FUSE_OPTION_DEPENDENCY', ['name', 'displayFolder'], /only used.*displayFolder/],
    [{ modules: 'subdir:../unsafe' }, 'linux', 'ERR_FUSE_OPTION_VALUE', ['modules'], /module identifiers/]
  ]

  for (const [options, platform, code, names, message] of cases) {
    let error = null
    try {
      validateFuse3Options(options, platform)
    } catch (err) {
      error = err
    }

    t.ok(error instanceof TypeError, `${code} is a TypeError`)
    t.equal(error && error.code, code, `${code} has a stable code`)
    t.deepEqual(error && error.options, names, `${code} identifies its options`)
    t.match(error && error.message, message, `${code} is actionable`)
  }

  t.doesNotThrow(
    () => validateFuse3Options({
      autoCache: true,
      acAttrTimeout: 1,
      blkdev: true,
      blksize: 4096,
      fsname: '/dev/loop0',
      modules: 'subdir:iconv'
    }, 'linux'),
    'a conforming Linux FUSE 3 configuration passes'
  )
  t.end()
})

tape('public option preflight uses the constructor validation contract', function (t) {
  t.equal(Fuse.validateOptions({ direct_io: true, nonempty: false }), undefined)

  let error = null
  try {
    Fuse.validateOptions({ nonempty: true })
  } catch (err) {
    error = err
  }
  t.equal(error && error.code, 'ERR_FUSE_OPTION_REMOVED')
  t.deepEqual(error && error.options, ['nonEmpty'])
  t.end()
})
