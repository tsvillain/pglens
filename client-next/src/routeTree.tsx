import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router'
import { Home } from './pages/Home'
import { TableView } from './pages/TableView'
import { SchemaViz } from './pages/SchemaViz'
import { QueryRunner } from './pages/QueryRunner'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { Spotlight } from './components/Spotlight'

function RootLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
      <Spotlight />
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
})

const tableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tables/$tableName',
  component: TableView,
})

const schemaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schema',
  component: SchemaViz,
})

const queryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/query',
  component: QueryRunner,
})

export const routeTree = rootRoute.addChildren([
  homeRoute,
  tableRoute,
  schemaRoute,
  queryRoute,
])
