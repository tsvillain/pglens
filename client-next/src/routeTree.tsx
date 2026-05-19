import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router'
import { Home } from './pages/Home'
import { TableView } from './pages/TableView'
import { SchemaViz } from './pages/SchemaViz'
import { QueryRunner } from './pages/QueryRunner'
import { Sidebar } from './components/Sidebar'

function RootLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
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
