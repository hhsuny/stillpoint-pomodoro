import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type View = 'today' | 'calendar' | 'summary'
type TimerMode = 'focus' | 'shortBreak' | 'longBreak'
type TaskStatus = 'open' | 'done'

type Task = {
  id: string
  title: string
  estimate: number
  completed: number
  status: TaskStatus
  date: string
  originalDate: string
  carriedFromId?: string
}

type Session = {
  id: string
  taskId: string | null
  mode: TimerMode
  date: string
  startedAt: number
  endedAt: number
  completed: boolean
  actualSeconds: number
  interruptionReason?: string
}

type Summary = {
  date: string
  note: string
}

type Store = {
  tasks: Task[]
  sessions: Session[]
  summaries: Summary[]
}

type TimerState = {
  mode: TimerMode
  taskId: string | null
  running: boolean
  remaining: number
  endAt: number | null
  startedAt: number | null
  cycle: number
}

type Settings = {
  quickMode: boolean
  sound: boolean
  notifications: boolean
}

type NotificationPermissionState = 'unsupported' | NotificationPermission

const STORAGE_KEY = 'stillpoint-demo-v1'
const TIMER_KEY = 'stillpoint-timer-v1'
const SETTINGS_KEY = 'stillpoint-settings-v1'
const defaultDurations = { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 }
const quickDurations = { focus: 30, shortBreak: 10, longBreak: 15 }

const pad = (value: number) => String(value).padStart(2, '0')

const dateKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  return `${year}-${month}-${day}`
}

const parseDate = (key: string) => {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const shiftDate = (key: string, amount: number) => {
  const next = parseDate(key)
  next.setDate(next.getDate() + amount)
  return dateKey(next)
}

const formatDate = (key: string, options: Intl.DateTimeFormatOptions) =>
  parseDate(key).toLocaleDateString('zh-CN', options)

const todayLabel = (key: string) => formatDate(key, { month: 'long', day: 'numeric', weekday: 'long' })

const formatTime = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const seedStore = (today: string): Store => {
  const yesterday = shiftDate(today, -1)
  const twoDaysAgo = shiftDate(today, -2)
  const tasks: Task[] = [
    { id: 'task-writing', title: '写完产品需求稿', estimate: 3, completed: 1, status: 'open', date: today, originalDate: today },
    { id: 'task-notes', title: '整理阅读笔记', estimate: 2, completed: 0, status: 'open', date: today, originalDate: today },
    { id: 'task-walk', title: '散步与拉伸', estimate: 1, completed: 1, status: 'done', date: today, originalDate: today },
    { id: 'task-archive', title: '整理上周的素材', estimate: 2, completed: 2, status: 'done', date: yesterday, originalDate: yesterday },
  ]
  const sessions: Session[] = [
    { id: 'seed-today-1', taskId: 'task-writing', mode: 'focus', date: today, startedAt: Date.now() - 10 * 60_000, endedAt: Date.now() - 9 * 60_000, completed: true, actualSeconds: 1500 },
    { id: 'seed-today-2', taskId: 'task-walk', mode: 'focus', date: today, startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 29 * 60_000, completed: true, actualSeconds: 1500 },
    { id: 'seed-yesterday-1', taskId: 'task-archive', mode: 'focus', date: yesterday, startedAt: Date.now() - 24 * 60 * 60_000, endedAt: Date.now() - 24 * 60 * 60_000 + 1500_000, completed: true, actualSeconds: 1500 },
    { id: 'seed-yesterday-2', taskId: 'task-archive', mode: 'focus', date: yesterday, startedAt: Date.now() - 23 * 60 * 60_000, endedAt: Date.now() - 23 * 60 * 60_000 + 1500_000, completed: true, actualSeconds: 1500 },
    { id: 'seed-two-days-1', taskId: null, mode: 'focus', date: twoDaysAgo, startedAt: Date.now() - 48 * 60 * 60_000, endedAt: Date.now() - 48 * 60 * 60_000 + 1500_000, completed: true, actualSeconds: 1500 },
  ]
  return {
    tasks,
    sessions,
    summaries: [
      { date: yesterday, note: '把素材归档后，下午的写作顺利很多。' },
      { date: twoDaysAgo, note: '先开始一个番茄，状态就慢慢回来了。' },
    ],
  }
}

const getStoredStore = (today: string): Store => {
  const emptyStore = (): Store => ({ tasks: [], sessions: [], summaries: [] })
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return import.meta.env.DEV ? seedStore(today) : emptyStore()
    const parsed = JSON.parse(saved) as Partial<Store>
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
    }
  } catch {
    return import.meta.env.DEV ? seedStore(today) : emptyStore()
  }
}

const carryOverIncompleteTasks = (store: Store, today: string): Store => {
  const candidates = store.tasks.filter((task) => {
    if (task.status !== 'open' || task.date >= today) return false
    const hasLaterOpenCopy = store.tasks.some((other) =>
      other.status === 'open' &&
      other.date > task.date &&
      other.date < today &&
      other.originalDate === task.originalDate &&
      other.title === task.title,
    )
    const alreadyCarriedToday = store.tasks.some((other) =>
      other.date === today && other.carriedFromId === task.id,
    )
    return !hasLaterOpenCopy && !alreadyCarriedToday
  })
  if (!candidates.length) return store
  const carriedTasks = candidates.map((task) => ({
    ...task,
    id: makeId('task'),
    date: today,
    carriedFromId: task.id,
    status: 'open' as TaskStatus,
  }))
  return { ...store, tasks: [...store.tasks, ...carriedTasks] }
}

const getStoredTimer = (durations: typeof defaultDurations): TimerState => {
  try {
    const saved = localStorage.getItem(TIMER_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as TimerState
      const remaining = parsed.running && parsed.endAt ? Math.max(0, Math.ceil((parsed.endAt - Date.now()) / 1000)) : parsed.remaining
      return { ...parsed, remaining }
    }
  } catch {
    // Use a clean timer when local data is unavailable.
  }
  return { mode: 'focus', taskId: null, running: false, remaining: durations.focus, endAt: null, startedAt: null, cycle: 0 }
}

const modeLabel: Record<TimerMode, string> = { focus: '专注时段', shortBreak: '短休息', longBreak: '长休息' }

const modeHint: Record<TimerMode, string> = {
  focus: '一段时间，只做一件事。',
  shortBreak: '站起来，离开屏幕几分钟。',
  longBreak: '四个番茄完成了，给自己真正的休息。',
}

const inspirationQuotes = [
  '先完成，再完善。今天的这一轮，已经算数。',
  '不必等状态出现，先把眼前的五分钟做好。',
  '把大目标拆成眼前这一小段，路就会变得清楚。',
  '走得慢没有关系，持续往前就好。',
  '自律不是逼自己，是给未来的自己留一条路。',
  '好的结果，常常来自平静地重复。',
  '你不需要一次改变全部，只需要完成这一轮。',
  '现在开始，永远比继续等待更接近答案。',
  '把注意力放回当下，下一步自然会出现。',
  '今天多做的一点，会成为明天更轻松的起点。',
]

const getMonthCells = (month: Date) => {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const startOffset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - startOffset)
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(start)
    current.setDate(start.getDate() + index)
    return { key: dateKey(current), date: current, inMonth: current.getMonth() === month.getMonth() }
  })
}

function App() {
  const today = dateKey()
  const initialSettings: Settings = (() => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '') as Settings
    } catch {
      return { quickMode: false, sound: true, notifications: false }
    }
  })()
  const [view, setView] = useState<View>('today')
  const [store, setStore] = useState<Store>(() => getStoredStore(today))
  const [settings, setSettings] = useState<Settings>(initialSettings)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const durations = settings.quickMode ? quickDurations : defaultDurations
  const [timer, setTimer] = useState<TimerState>(() => getStoredTimer(durations))
  const [selectedDate, setSelectedDate] = useState(today)
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskEstimate, setTaskEstimate] = useState(2)
  const [toast, setToast] = useState<string | null>(null)
  const finishTimerRef = useRef<() => void>(() => undefined)

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store)), [store])
  useEffect(() => localStorage.setItem(TIMER_KEY, JSON.stringify(timer)), [timer])
  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings])
  useEffect(() => {
    if (typeof Notification !== 'undefined') setNotificationPermission(Notification.permission)
  }, [])
  useEffect(() => {
    setStore((current) => carryOverIncompleteTasks(current, today))
  }, [today])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3400)
  }, [])

  const todaySessions = useMemo(() => store.sessions.filter((session) => session.date === today && session.completed && session.mode === 'focus'), [store.sessions, today])
  const todayTasks = useMemo(() => store.tasks.filter((task) => task.date === today), [store.tasks, today])
  const selectedTask = useMemo(() => store.tasks.find((task) => task.id === timer.taskId) || null, [store.tasks, timer.taskId])
  const completedTaskCount = todayTasks.filter((task) => task.status === 'done').length
  const todayMinutes = Math.round(todaySessions.reduce((total, session) => total + session.actualSeconds, 0) / 60)

  const completedByDate = useMemo(() => {
    return store.sessions.reduce<Record<string, number>>((result, session) => {
      if (session.completed && session.mode === 'focus') result[session.date] = (result[session.date] || 0) + 1
      return result
    }, {})
  }, [store.sessions])

  const currentStreak = useMemo(() => {
    let streak = 0
    let cursor = today
    while ((completedByDate[cursor] || 0) > 0) {
      streak += 1
      cursor = shiftDate(cursor, -1)
    }
    return streak
  }, [completedByDate, today])

  const longestStreak = useMemo(() => {
    const dates = Object.keys(completedByDate).sort()
    let longest = 0
    let run = 0
    let previous = ''
    dates.forEach((date) => {
      run = previous && shiftDate(previous, 1) === date ? run + 1 : 1
      longest = Math.max(longest, run)
      previous = date
    })
    return longest
  }, [completedByDate])

  const recordInterrupted = useCallback((current: TimerState, reason: string) => {
    if (current.mode !== 'focus' || !current.startedAt) return
    const now = Date.now()
    const remaining = current.running && current.endAt
      ? Math.max(0, Math.ceil((current.endAt - now) / 1000))
      : current.remaining
    const actualSeconds = Math.max(0, durations.focus - remaining)
    if (actualSeconds < 1) return
    const session: Session = {
      id: makeId('session'),
      taskId: current.taskId,
      mode: 'focus',
      date: dateKey(current.startedAt ? new Date(current.startedAt) : new Date()),
      startedAt: current.startedAt,
      endedAt: now,
      completed: false,
      actualSeconds,
      interruptionReason: reason,
    }
    setStore((existing) => ({ ...existing, sessions: [...existing.sessions, session] }))
  }, [durations.focus])

  const setMode = useCallback((mode: TimerMode, taskId: string | null = timer.taskId) => {
    if (timer.mode === 'focus' && timer.startedAt && (timer.running || timer.remaining < durations.focus)) recordInterrupted(timer, '切换阶段')
    setTimer((current) => ({ ...current, mode, taskId, running: false, remaining: durations[mode], endAt: null, startedAt: null }))
  }, [durations, recordInterrupted, timer])

  const playBeep = useCallback(() => {
    if (!settings.sound) return
    try {
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = 640
      gain.gain.setValueAtTime(0.08, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.5)
    } catch {
      // Audio may be unavailable until the next user gesture.
    }
  }, [settings.sound])

  const notify = useCallback((message: string) => {
    if (settings.notifications && 'Notification' in window && Notification.permission === 'granted') new Notification('Stillpoint', { body: message })
  }, [settings.notifications])

  const finishTimer = useCallback(() => {
    setTimer((current) => {
      if (!current.running) return current
      const finishedMode = current.mode
      if (finishedMode === 'focus') {
        const now = Date.now()
        const session: Session = { id: makeId('session'), taskId: current.taskId, mode: 'focus', date: dateKey(), startedAt: current.startedAt || now - durations.focus * 1000, endedAt: now, completed: true, actualSeconds: durations.focus }
        setStore((existing) => {
          const updatedTasks = existing.tasks.map((task) => {
            if (task.id !== current.taskId) return task
            const completed = task.completed + 1
            return { ...task, completed, status: completed >= task.estimate ? 'done' : task.status }
          })
          return { ...existing, tasks: updatedTasks, sessions: [...existing.sessions, session] }
        })
        playBeep()
        const nextCycle = current.cycle + 1
        const nextMode = nextCycle % 4 === 0 ? 'longBreak' : 'shortBreak'
        const message = nextMode === 'longBreak' ? '四个番茄完成，开始长休息。' : '专注完成，开始短休息。'
        showToast(message)
        notify(message)
        return { ...current, mode: nextMode, running: false, remaining: durations[nextMode], endAt: null, startedAt: null, cycle: nextCycle }
      }
      const message = '休息结束，准备好开始下一轮了吗？'
      playBeep()
      showToast(message)
      notify(message)
      return { ...current, mode: 'focus', running: false, remaining: durations.focus, endAt: null, startedAt: null }
    })
  }, [durations, notify, playBeep, showToast])

  finishTimerRef.current = finishTimer

  useEffect(() => {
    if (!timer.running || !timer.endAt) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((timer.endAt! - Date.now()) / 1000))
      setTimer((current) => current.remaining === remaining ? current : ({ ...current, remaining }))
      if (remaining <= 0) finishTimerRef.current()
    }
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [timer.running, timer.endAt])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && timer.running && timer.endAt && timer.endAt <= Date.now()) finishTimerRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [timer.running, timer.endAt])

  const toggleTimer = () => {
    if (timer.running) {
      const remaining = timer.endAt ? Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000)) : timer.remaining
      setTimer((current) => ({ ...current, running: false, remaining, endAt: null }))
      showToast('已暂停，回来时从这里继续。')
      return
    }
    const now = Date.now()
    setTimer((current) => ({ ...current, running: true, endAt: now + current.remaining * 1000, startedAt: current.startedAt || now }))
    showToast(timer.mode === 'focus' ? '专注开始，先照顾好这一段时间。' : '休息开始。')
  }

  const resetTimer = () => {
    recordInterrupted(timer, '重置')
    setTimer((current) => ({ ...current, running: false, remaining: durations[current.mode], endAt: null, startedAt: null }))
    showToast('这一轮已重置。')
  }

  const skipTimer = () => {
    recordInterrupted(timer, '跳过')
    const nextMode = timer.mode === 'focus' ? (timer.cycle + 1) % 4 === 0 ? 'longBreak' : 'shortBreak' : 'focus'
    setMode(nextMode)
    showToast(`已跳到${modeLabel[nextMode]}。`)
  }

  const addTask = (event: React.FormEvent) => {
    event.preventDefault()
    const title = taskTitle.trim()
    if (!title) return
    const task: Task = { id: makeId('task'), title, estimate: taskEstimate, completed: 0, status: 'open', date: today, originalDate: today }
    setStore((current) => ({ ...current, tasks: [...current.tasks, task] }))
    setTaskTitle('')
    setTaskEstimate(2)
    showToast('任务已加入今天。')
  }

  const selectTask = (task: Task) => {
    setTimer((current) => ({ ...current, taskId: task.id }))
    setView('today')
  }

  const toggleTaskStatus = (taskId: string) => {
    setStore((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: task.status === 'done' ? 'open' : 'done' } : task) }))
  }

  const toggleNotifications = async () => {
    if (settings.notifications) {
      setSettings((current) => ({ ...current, notifications: false }))
      return
    }
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported')
      showToast('当前浏览器不支持通知，页面提醒仍会保留。')
      return
    }
    if (Notification.permission === 'denied') {
      setNotificationPermission('denied')
      showToast('Edge 已阻止通知：请点击地址栏左侧图标，将“通知”改为“允许”，再刷新页面。')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission !== 'granted') {
        showToast('通知没有开启，页面提醒仍会保留。')
        return
      }
      setSettings((current) => ({ ...current, notifications: true }))
      showToast('浏览器通知已开启。')
    } catch {
      showToast('浏览器没有弹出权限窗口，请检查地址栏的通知权限。')
    }
  }

  const openNotificationSettings = () => {
    const settingsWindow = window.open('edge://settings/content/notifications', '_blank', 'noopener,noreferrer')
    if (!settingsWindow) showToast('请在 Edge 地址栏打开 edge://settings/content/notifications')
  }

  const exportBackup = () => {
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), store, settings }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `stillpoint-backup-${today}.json`
    link.click()
    URL.revokeObjectURL(url)
    showToast('备份文件已下载。')
  }

  const importBackup = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { store?: Store; settings?: Settings }
      if (!parsed.store || !Array.isArray(parsed.store.tasks) || !Array.isArray(parsed.store.sessions) || !Array.isArray(parsed.store.summaries)) throw new Error('备份文件格式不正确')
      setStore(parsed.store)
      if (parsed.settings) setSettings(parsed.settings)
      showToast('备份已恢复。')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '备份恢复失败。')
    }
  }

  const resetDemo = () => {
    const fresh = seedStore(today)
    setStore(fresh)
    setTimer({ mode: 'focus', taskId: null, running: false, remaining: durations.focus, endAt: null, startedAt: null, cycle: 0 })
    setSettingsOpen(false)
    showToast('演示数据已恢复。')
  }

  const ringProgress = 1 - timer.remaining / durations[timer.mode]
  const ringRadius = 138
  const ringLength = 2 * Math.PI * ringRadius
  const currentSummary = store.summaries.find((summary) => summary.date === selectedDate)
  const monthCells = getMonthCells(calendarMonth)
  const monthCount = monthCells.filter((cell) => cell.inMonth).reduce((total, cell) => total + (completedByDate[cell.key] || 0), 0)
  const inspirationQuote = inspirationQuotes[parseDate(today).getDate() % inspirationQuotes.length]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">s</div>
          <div><strong>stillpoint</strong><span>专注时间</span></div>
        </div>
        <nav className="main-nav" aria-label="主导航">
          <button className={view === 'today' ? 'nav-item active' : 'nav-item'} onClick={() => setView('today')}><span className="nav-icon">○</span>今天</button>
          <button className={view === 'calendar' ? 'nav-item active' : 'nav-item'} onClick={() => setView('calendar')}><span className="nav-icon">□</span>坚持日历</button>
          <button className={view === 'summary' ? 'nav-item active' : 'nav-item'} onClick={() => setView('summary')}><span className="nav-icon">≡</span>每日总结</button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-streak">
          <div className="eyebrow">CURRENT STREAK</div>
          <div className="streak-number">{currentStreak}<span>天</span></div>
          <div className="streak-caption">每天一个番茄，也算向前。</div>
        </div>
        <button className="settings-link" onClick={() => setSettingsOpen(true)}><span>⚙</span>设置</button>
        <div className="profile-chip"><span className="avatar">林</span><span><strong>我的专注空间</strong><small>本地 Demo</small></span><span className="status-dot" /></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><div className="eyebrow">{view === 'today' ? 'FOCUS DESK' : view === 'calendar' ? 'YOUR RHYTHM' : 'A SMALL REFLECTION'}</div><h1>{view === 'today' ? '今天，慢一点也没关系。' : view === 'calendar' ? '把时间变成看得见的坚持。' : '给今天留一行话。'}</h1></div>
          <div className="topbar-actions"><span className="date-badge">{formatDate(today, { month: 'short', day: 'numeric' })}</span><button className="icon-button" title="打开设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>⚙</button></div>
        </header>

        {view === 'today' && <TodayView
          today={today}
          todayTasks={todayTasks}
          timer={timer}
          selectedTask={selectedTask}
          durations={durations}
          ringProgress={ringProgress}
          ringLength={ringLength}
          ringRadius={ringRadius}
          todaySessions={todaySessions}
          todayMinutes={todayMinutes}
          completedTaskCount={completedTaskCount}
          taskTitle={taskTitle}
          taskEstimate={taskEstimate}
          onTaskTitleChange={setTaskTitle}
          onTaskEstimateChange={setTaskEstimate}
          onAddTask={addTask}
          onSelectTask={selectTask}
          onToggleTask={toggleTaskStatus}
          onToggleTimer={toggleTimer}
          onResetTimer={resetTimer}
          onSkipTimer={skipTimer}
          onSetMode={setMode}
          currentStreak={currentStreak}
          longestStreak={longestStreak}
          showToast={showToast}
          inspirationQuote={inspirationQuote}
        />}
        {view === 'calendar' && <CalendarView month={calendarMonth} cells={monthCells} today={today} completedByDate={completedByDate} monthCount={monthCount} currentStreak={currentStreak} longestStreak={longestStreak} onChangeMonth={setCalendarMonth} onSelectDate={(key) => { setSelectedDate(key); setView('summary') }} />}
        {view === 'summary' && <SummaryView selectedDate={selectedDate} currentSummary={currentSummary} sessions={store.sessions} tasks={store.tasks} currentStreak={currentStreak} onSelectDate={setSelectedDate} onSave={(note) => { setStore((current) => ({ ...current, summaries: [...current.summaries.filter((summary) => summary.date !== selectedDate), { date: selectedDate, note }] })); showToast('这一天已经记下来了。') }} />}
      </main>

      {toast && <div className="toast" role="status"><span className="toast-dot" />{toast}</div>}
      {settingsOpen && <SettingsModal settings={settings} notificationPermission={notificationPermission} onChange={setSettings} onToggleNotifications={toggleNotifications} onOpenNotificationSettings={openNotificationSettings} onExportBackup={exportBackup} onImportBackup={importBackup} onClose={() => setSettingsOpen(false)} onReset={resetDemo} />}
    </div>
  )
}

type TodayProps = {
  today: string
  todayTasks: Task[]
  timer: TimerState
  selectedTask: Task | null
  durations: typeof defaultDurations
  ringProgress: number
  ringLength: number
  ringRadius: number
  todaySessions: Session[]
  todayMinutes: number
  completedTaskCount: number
  taskTitle: string
  taskEstimate: number
  onTaskTitleChange: (value: string) => void
  onTaskEstimateChange: (value: number) => void
  onAddTask: (event: React.FormEvent) => void
  onSelectTask: (task: Task) => void
  onToggleTask: (id: string) => void
  onToggleTimer: () => void
  onResetTimer: () => void
  onSkipTimer: () => void
  onSetMode: (mode: TimerMode, taskId?: string | null) => void
  currentStreak: number
  longestStreak: number
  showToast: (message: string) => void
  inspirationQuote: string
}

function TodayView(props: TodayProps) {
  const { today, todayTasks, timer, selectedTask, durations, ringProgress, ringLength, ringRadius, todaySessions, todayMinutes, completedTaskCount, taskTitle, taskEstimate, onTaskTitleChange, onTaskEstimateChange, onAddTask, onSelectTask, onToggleTask, onToggleTimer, onResetTimer, onSkipTimer, onSetMode, currentStreak, longestStreak, inspirationQuote } = props
  const focusTotal = todayTasks.reduce((total, task) => total + task.completed, 0)
  const plannedTotal = todayTasks.reduce((total, task) => total + task.estimate, 0)

  return <div className="today-layout">
    <section className="panel task-panel">
      <div className="panel-header"><div><div className="eyebrow">{todayLabel(today)}</div><h2>今天要做什么</h2></div><span className="count-label">{focusTotal}/{plannedTotal} 番茄</span></div>
      <div className="task-progress"><span style={{ width: `${plannedTotal ? Math.min(100, focusTotal / plannedTotal * 100) : 0}%` }} /></div>
      <form className="new-task-form" onSubmit={onAddTask}><input value={taskTitle} onChange={(event) => onTaskTitleChange(event.target.value)} placeholder="添加一个今天的任务…" aria-label="添加任务" /><div className="estimate-control"><button type="button" title="减少预计番茄" aria-label="减少预计番茄" onClick={() => onTaskEstimateChange(Math.max(1, taskEstimate - 1))}>−</button><span>{taskEstimate}</span><button type="button" title="增加预计番茄" aria-label="增加预计番茄" onClick={() => onTaskEstimateChange(Math.min(8, taskEstimate + 1))}>+</button></div><button className="add-task-button" type="submit" title="添加任务" aria-label="添加任务">+</button></form>
      <div className="task-list">{todayTasks.map((task) => <TaskRow key={task.id} task={task} active={timer.taskId === task.id} onSelect={() => onSelectTask(task)} onToggle={() => onToggleTask(task.id)} />)}</div>
      <div className="task-footnote"><span className="tiny-check">✓</span> 完成一个番茄，就给今天留下一点证据。</div>
    </section>

    <section className={`timer-panel ${timer.mode}`}>
      <div className="timer-topline"><span className={`phase-pill ${timer.mode}`}>{modeLabel[timer.mode]}</span><span className="cycle-count">第 {timer.cycle % 4 + 1} / 4 轮</span></div>
      <div className="timer-stage">
        <svg className="timer-ring" viewBox="0 0 320 320" aria-hidden="true"><circle className="ring-track" cx="160" cy="160" r={ringRadius} /><circle className="ring-progress" cx="160" cy="160" r={ringRadius} strokeDasharray={ringLength} strokeDashoffset={ringLength * (1 - ringProgress)} /></svg>
        <div className="timer-readout"><span className="timer-time">{formatTime(timer.remaining)}</span><span className="timer-status">{timer.running ? '正在进行' : timer.remaining === durations[timer.mode] ? '准备好了吗' : '已暂停'}</span></div>
      </div>
      <div className="timer-context">{timer.mode === 'focus' ? <><span className="context-label">当前任务</span><strong>{selectedTask?.title || '选择一个任务，开始这一轮'}</strong></> : <><span className="context-label">接下来</span><strong>{modeHint[timer.mode]}</strong></>}</div>
      <div className="timer-controls"><button className="secondary-control" title="重置这一轮" aria-label="重置这一轮" onClick={onResetTimer}>↻</button><button className="primary-control" onClick={onToggleTimer}>{timer.running ? <><span className="button-symbol">Ⅱ</span>暂停</> : <><span className="button-symbol">▶</span>{timer.remaining === durations[timer.mode] ? '开始专注' : '继续'}</>}</button><button className="secondary-control" title="跳过这一阶段" aria-label="跳过这一阶段" onClick={onSkipTimer}>→</button></div>
      <div className="mode-switcher" role="tablist" aria-label="计时模式"><button className={timer.mode === 'focus' ? 'selected' : ''} onClick={() => onSetMode('focus')}><span className="mode-icon focus-icon" aria-hidden="true">◉</span><span>专注</span></button><button className={timer.mode === 'shortBreak' ? 'selected' : ''} onClick={() => onSetMode('shortBreak')}><span className="mode-icon break-icon" aria-hidden="true">☕</span><span>短休息</span></button><button className={timer.mode === 'longBreak' ? 'selected' : ''} onClick={() => onSetMode('longBreak')}><span className="mode-icon long-break-icon" aria-hidden="true">✦</span><span>长休息</span></button></div>
      <p className="timer-note">{modeHint[timer.mode]}</p>
    </section>

    <aside className="insight-column">
      <section className="panel day-progress-panel"><div className="panel-header"><div><div className="eyebrow">TODAY IN FOCUS</div><h3>今天的节奏</h3></div><span className="mini-spark">↗</span></div><div className="metric-large">{todayMinutes}<span>分钟</span></div><div className="metric-caption">{todaySessions.length} 个完整番茄 · {completedTaskCount} 个任务完成</div><div className="session-dots">{Array.from({ length: 8 }, (_, index) => <span key={index} className={index < todaySessions.length ? 'filled' : ''} />)}</div></section>
      <section className="panel streak-panel"><div className="eyebrow">KEEP GOING</div><div className="streak-line"><strong>{currentStreak}</strong><span>天连续<br />最长 {longestStreak} 天</span></div><div className="streak-bar"><span style={{ width: `${Math.min(100, currentStreak / Math.max(longestStreak, 7) * 100)}%` }} /></div><p>不需要完美，只需要回来。</p></section>
      <section className="quiet-note"><div className="eyebrow">TODAY'S NOTE</div><span>“</span><p>{inspirationQuote}</p></section>
    </aside>
  </div>
}

function TaskRow({ task, active, onSelect, onToggle }: { task: Task; active: boolean; onSelect: () => void; onToggle: () => void }) {
  return <div className={`task-row ${active ? 'active' : ''} ${task.status === 'done' ? 'done' : ''}`}><button className="task-check" onClick={onToggle} title={task.status === 'done' ? '标记为未完成' : '标记完成'} aria-label={task.status === 'done' ? '标记为未完成' : '标记完成'}>{task.status === 'done' ? '✓' : ''}</button><button className="task-main" onClick={onSelect}><span className="task-title">{task.title}</span><span className="task-meta"><span className="pips">{Array.from({ length: task.estimate }, (_, index) => <i key={index} className={index < task.completed ? 'filled' : ''} />)}</span>{task.completed}/{task.estimate} 番茄{task.carriedFromId && <em className="carried-label">顺延</em>}</span></button><span className="task-arrow">{active ? '●' : '·'}</span></div>
}

function CalendarView({ month, cells, today, completedByDate, monthCount, currentStreak, longestStreak, onChangeMonth, onSelectDate }: { month: Date; cells: { key: string; date: Date; inMonth: boolean }[]; today: string; completedByDate: Record<string, number>; monthCount: number; currentStreak: number; longestStreak: number; onChangeMonth: (date: Date) => void; onSelectDate: (key: string) => void }) {
  const changeMonth = (amount: number) => { const next = new Date(month.getFullYear(), month.getMonth() + amount, 1); onChangeMonth(next) }
  return <div className="calendar-page"><div className="page-intro"><div><div className="eyebrow">YOUR RHYTHM</div><h2>每天一点，时间会记得。</h2><p>完成一个番茄，就在这一天留下一枚小小的勾。</p></div><div className="calendar-stats"><div><strong>{currentStreak}</strong><span>当前连续</span></div><div><strong>{longestStreak}</strong><span>最长连续</span></div><div><strong>{monthCount}</strong><span>本月番茄</span></div></div></div><section className="calendar-card"><div className="calendar-toolbar"><button className="icon-button" onClick={() => changeMonth(-1)} title="上个月" aria-label="上个月">←</button><h3>{month.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</h3><button className="icon-button" onClick={() => changeMonth(1)} title="下个月" aria-label="下个月">→</button><button className="today-button" onClick={() => onChangeMonth(new Date())}>回到今天</button></div><div className="weekday-row">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((cell) => { const count = completedByDate[cell.key] || 0; return <button key={cell.key} className={`calendar-day ${cell.inMonth ? '' : 'muted'} ${cell.key === today ? 'today' : ''} ${count ? 'checked' : ''}`} onClick={() => onSelectDate(cell.key)}><span className="day-number">{cell.date.getDate()}</span>{count > 0 && <span className="day-check">✓</span>}<span className="day-pips">{Array.from({ length: Math.min(count, 4) }, (_, index) => <i key={index} />)}</span></button> })}</div><div className="calendar-legend"><span><i className="legend-check">✓</i>完成过番茄</span><span><i className="legend-pip" />每个点代表一个番茄</span><span className="legend-help">点击某一天查看总结</span></div></section></div>
}

function SummaryView({ selectedDate, currentSummary, sessions, tasks, currentStreak, onSelectDate, onSave }: { selectedDate: string; currentSummary?: Summary; sessions: Session[]; tasks: Task[]; currentStreak: number; onSelectDate: (date: string) => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState(currentSummary?.note || '')
  useEffect(() => setNote(currentSummary?.note || ''), [currentSummary?.note, selectedDate])
  const completed = sessions.filter((session) => session.date === selectedDate && session.completed && session.mode === 'focus')
  const interrupted = sessions.filter((session) => session.date === selectedDate && !session.completed && session.mode === 'focus')
  const minutes = Math.round(completed.reduce((sum, session) => sum + session.actualSeconds, 0) / 60)
  const taskCount = tasks.filter((task) => task.date === selectedDate && task.status === 'done').length
  const previous = shiftDate(selectedDate, -1)
  const events = sessions.filter((session) => session.date === selectedDate && session.mode === 'focus').slice(-4)
  return <div className="summary-page"><div className="summary-top"><div><div className="eyebrow">DAILY REFLECTION</div><h2>这一天，留下什么。</h2><p>不是复盘得多完整，而是给自己一个回来的位置。</p></div><div className="date-picker"><button className="icon-button" title="前一天" aria-label="前一天" onClick={() => onSelectDate(previous)}>←</button><strong>{formatDate(selectedDate, { month: 'long', day: 'numeric', weekday: 'short' })}</strong><button className="icon-button" title="后一天" aria-label="后一天" onClick={() => onSelectDate(shiftDate(selectedDate, 1))}>→</button></div></div><div className="summary-grid"><section className="summary-card main-summary"><div className="eyebrow">A FEW NUMBERS</div><div className="summary-metrics"><div><strong>{completed.length}</strong><span>个番茄</span></div><div><strong>{minutes}</strong><span>分钟专注</span></div><div><strong>{taskCount}</strong><span>项完成</span></div><div><strong>{interrupted.length}</strong><span>次中断</span></div></div><div className="reflection-block"><label htmlFor="daily-note">写给今天的一句话</label><textarea id="daily-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="今天什么时刻最值得记住？" /><button className="save-note" onClick={() => onSave(note)}>保存这一天 <span>↗</span></button></div></section><section className="summary-card summary-side"><div className="eyebrow">THE THREAD</div><div className="summary-side-number">{currentStreak}<span>天</span></div><p>连续回来，比偶尔做到完美更重要。</p><div className="summary-divider" /><div className="eyebrow">WHAT HAPPENED</div><div className="summary-timeline">{events.length ? events.map((session) => <div className="timeline-item" key={session.id}><span className={`timeline-dot ${session.completed ? '' : 'interrupted'}`} /><span>{new Date(session.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span><strong>{session.completed ? session.taskId ? tasks.find((task) => task.id === session.taskId)?.title || '专注时段' : '无任务专注' : `中断：${session.interruptionReason || '提前结束'}`}</strong></div>) : <p className="empty-text">这一天还没有专注记录。</p>}</div></section></div></div>
}

function SettingsModal({ settings, notificationPermission, onChange, onToggleNotifications, onOpenNotificationSettings, onExportBackup, onImportBackup, onClose, onReset }: { settings: Settings; notificationPermission: NotificationPermissionState; onChange: (settings: Settings) => void; onToggleNotifications: () => void; onOpenNotificationSettings: () => void; onExportBackup: () => void; onImportBackup: (file: File) => Promise<void>; onClose: () => void; onReset: () => void }) {
  const notificationHint = notificationPermission === 'denied'
    ? 'Edge 已阻止：点击地址栏左侧图标，将通知改为允许后刷新页面。'
    : notificationPermission === 'unsupported'
      ? '当前浏览器不支持通知，页面内提醒仍会保留。'
      : notificationPermission === 'granted'
        ? '已允许在后台标签页提醒你。'
        : '点击开关后，Edge 会请求通知权限。'
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><div className="eyebrow">PERSONAL SETTINGS</div><h2 id="settings-title">让它适合你。</h2></div><button className="icon-button" onClick={onClose} title="关闭设置" aria-label="关闭设置">×</button></div><div className="setting-list"><label className="setting-row"><span><strong>演示模式</strong><small>专注 30 秒，短休息 10 秒，方便查看完整流程</small></span><input type="checkbox" checked={settings.quickMode} onChange={(event) => onChange({ ...settings, quickMode: event.target.checked })} /></label><label className="setting-row"><span><strong>结束声音</strong><small>阶段结束时播放轻提示音</small></span><input type="checkbox" checked={settings.sound} onChange={(event) => onChange({ ...settings, sound: event.target.checked })} /></label><div className="setting-row"><span><strong>浏览器通知</strong><small>{notificationHint}</small>{notificationPermission === 'denied' && <button className="permission-link" onClick={onOpenNotificationSettings}>打开 Edge 通知设置 ↗</button>}</span><button className={`toggle ${settings.notifications ? 'on' : ''}`} onClick={onToggleNotifications} aria-label="切换浏览器通知"><span /></button></div></div><div className="backup-section"><div><div className="eyebrow">LOCAL BACKUP</div><strong>为这台电脑留一份备份。</strong><small>备份包含任务、番茄记录、总结和设置。</small></div><div className="backup-actions"><button className="backup-button" onClick={onExportBackup}>导出备份</button><label className="backup-button">导入备份<input type="file" accept="application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImportBackup(file); event.currentTarget.value = '' }} /></label></div></div><div className="modal-footer"><button className="text-button" onClick={onReset}>恢复演示数据</button><span>数据保存在当前 Edge 浏览器</span></div></section></div>
}

export default App
