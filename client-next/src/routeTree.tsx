import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router'
import { Home } from './pages/Home'
import { TableView } from './pages/TableView'
import { SchemaViz } from './pages/SchemaViz'
import { QueryRunner } from './pages/QueryRunner'
import { Operations } from './pages/Operations'
import { SlowQueries } from './pages/SlowQueries'
import { IndexAssistant } from './pages/IndexAssistant'
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
  // Deep-linkable saved view: `?view=<uuid>` selects a saved view on load.
  // FK click-through: `?fkcol=<col>&fkval=<value>` opens the table with a
  // single equality filter pre-applied (the "show all rows that reference
  // this row" jump). Both fk params must be present to take effect.
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: string; fkcol?: string; fkval?: string } => {
    const out: { view?: string; fkcol?: string; fkval?: string } = {}
    const v = search.view
    if (typeof v === 'string' && v.length > 0) out.view = v
    const fkcol = search.fkcol
    const fkval = search.fkval
    if (
      typeof fkcol === 'string' && fkcol.length > 0 &&
      typeof fkval === 'string'
    ) {
      out.fkcol = fkcol
      out.fkval = fkval
    }
    return out
  },
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

const operationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/operations',
  component: Operations,
})

const slowQueriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/slow-queries',
  component: SlowQueries,
})

const indexAssistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/index-assistant',
  component: IndexAssistant,
})

export const routeTree = rootRoute.addChildren([
  homeRoute,
  tableRoute,
  schemaRoute,
  queryRoute,
  operationsRoute,
  slowQueriesRoute,
  indexAssistantRoute,
])
