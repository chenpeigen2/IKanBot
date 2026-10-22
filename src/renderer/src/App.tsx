import { useEffect, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { ToastProvider, NavIcon, type NavIconName } from './ui'
import Dashboard from './pages/Dashboard'
import Quotations from './pages/Quotations'
import Products from './pages/Products'
import Customers from './pages/Customers'
import Orders from './pages/Orders'
import Samples from './pages/Samples'
import OrderDetailPage from './pages/OrderDetail'
import Reports from './pages/Reports'
import Settings from './pages/Settings'

const NAV: { to: string; label: string; icon: NavIconName; end?: boolean }[] = [
  { to: '/', label: '工作台', icon: 'dashboard', end: true },
  { to: '/quotations', label: '报价', icon: 'quotation' },
  { to: '/orders', label: '订单', icon: 'order' },
  { to: '/samples', label: '打样单', icon: 'sample' },
  { to: '/products', label: '商品库', icon: 'products' },
  { to: '/customers', label: '客户', icon: 'customers' },
  { to: '/reports', label: '报表', icon: 'reports' },
  { to: '/settings', label: '设置', icon: 'settings' }
]

export default function App() {
  const [reminderCount, setReminderCount] = useState(0)
  const [appVersion, setAppVersion] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    // 从主进程拿真实版本号（侧边栏显示用）
    void window.api.updater.version().then(setAppVersion)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const list = await window.api.dashboard.reminders()
        setReminderCount(list.length)
      } catch {
        /* ignore */
      }
    }
    load()
    const t = setInterval(load, 120000)
    return () => clearInterval(t)
  }, [])

  return (
    <ToastProvider>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-name">IKanBot</div>
            <div className="brand-sub">外贸商品与单据系统</div>
          </div>
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <NavIcon name={n.icon} />
                <span>{n.label}</span>
                {n.to === '/' && reminderCount > 0 ? (
                  <span className="nav-badge">{reminderCount}</span>
                ) : null}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            Ctrl+Shift+H 隐藏窗口
            <br />
            {appVersion ? `v${appVersion}` : ''}
          </div>
        </aside>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard onNavigate={navigate} />} />
            <Route path="/quotations" element={<Quotations />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderDetailPage />} />
            <Route path="/samples" element={<Samples />} />
            <Route path="/products" element={<Products />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            {/* N26：输错网址不再白屏 */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  )
}

/** 404：手输错地址不再是一片白屏 */
function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 120 }}>
      <div style={{ fontSize: 46, marginBottom: 12 }}>🧭</div>
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>页面不存在</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        地址可能打错了，或者这个页面还没做。左边菜单里选一个吧。
      </p>
      <button className="btn primary" onClick={() => navigate('/')}>
        回首页
      </button>
    </div>
  )
}
