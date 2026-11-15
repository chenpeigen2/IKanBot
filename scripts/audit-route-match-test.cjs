/* 审计路由匹配器自测（R101）：共享件必须先证明「参数路由只吃一段」，再给两条审计用。
 * 跑法：node scripts/audit-route-match-test.cjs（已串进 npm run test:all） */
const assert = require('node:assert/strict')
const { normalizePath, matchRoute, findServerRoute } = require('./lib/audit-shared.cjs')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    throw err
  }
}

console.log('路径归一')
check('去掉 query 与 hash', () => assert.equal(normalizePath('/api/customers/list?x=1#top'), '/api/customers/list'))
check('补前导斜杠', () => assert.equal(normalizePath('api/customers/list'), '/api/customers/list'))
check('去掉非根尾斜杠', () => assert.equal(normalizePath('/api/customers/list/'), '/api/customers/list'))
check('根路径保留一个斜杠', () => assert.equal(normalizePath('/'), '/'))
check('空串归一为根路径', () => assert.equal(normalizePath(''), '/'))

console.log('路由匹配')
check('精确匹配', () => assert.equal(matchRoute('/api/customers/list', '/api/customers/list'), true))
check('单段参数匹配实际值', () => assert.equal(matchRoute('/api/files/images/:name', '/api/files/images/x.png'), true))
check('参数不能跨段', () => assert.equal(matchRoute('/api/files/images/:name', '/api/files/images/x.png/extra'), false))
check('参数不能为空', () => assert.equal(matchRoute('/api/files/images/:name', '/api/files/images/'), false))
check('段数必须相等', () => assert.equal(matchRoute('/api/customers/list', '/api/customers/list/extra'), false))
check('静态段不能张冠李戴', () => assert.equal(matchRoute('/api/customers/list', '/api/customers/get'), false))
check('多个参数逐段匹配', () =>
  assert.equal(matchRoute('/api/files/:kind/:name', '/api/files/images/x.png'), true))
check('query 与尾斜杠不参与匹配', () =>
  assert.equal(matchRoute('/api/files/images/:name', '/api/files/images/x.png/?v=2'), true))
check('根路径只匹配根路径', () => {
  assert.equal(matchRoute('/', '/'), true)
  assert.equal(matchRoute('/', '/api'), false)
})

console.log('路由查找')
check('字符串路由表返回命中的原字符串', () => {
  const routes = ['/api/customers/list', '/api/files/images/:name']
  assert.equal(findServerRoute('/api/files/images/x.png', routes), '/api/files/images/:name')
})
check('对象路由表返回命中的原对象', () => {
  const routes = [{ route: '/api/customers/list', method: 'POST' }, { route: '/api/files/images/:name', method: 'GET' }]
  assert.deepEqual(findServerRoute('/api/files/images/x.png?x=1', routes), routes[1])
})
check('找不到返回 null', () => assert.equal(findServerRoute('/api/files/images/x.png/extra', ['/api/files/images/:name']), null))
check('精确路由优先于参数路由', () => {
  const routes = ['/api/files/images/:name', '/api/files/images/upload']
  assert.equal(findServerRoute('/api/files/images/upload', routes), '/api/files/images/upload')
})

console.log(`\n路由匹配自测：${passed} 项全过`)
