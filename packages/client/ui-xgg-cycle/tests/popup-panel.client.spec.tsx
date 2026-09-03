// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import { PopupPanel } from '../src/client/PopupPanel.tsx'
import type { PanelController, PanelState } from '../src/client/controller.ts'
import { EMPTY_SERVER, IDLE_LOOP } from '../src/client/project-model.ts'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

function controller(): PanelController {
  const state: PanelState = {
    activeKey: 'workspace-1',
    projects: {
      'workspace-1': {
        requirements: [],
        groups: [],
        info: [],
        records: [],
        bugs: [],
        mode: 'simple',
        releaseTarget: 'cloudflare',
        server: { ...EMPTY_SERVER },
        extras: { prototype: '', develop: '', test: '', release: '' },
        planSessionId: '',
        loop: { ...IDLE_LOOP, steps: [] },
      },
    },
  }
  const store = createSnapshotStore(state)
  return {
    store,
    project: () => store.getSnapshot().projects['workspace-1']!,
    update: (mutate) => { store.update((draft) => { mutate(draft.projects['workspace-1']!) }) },
    handOff: vi.fn(() => Promise.resolve('session-1')),
    trackRecord: vi.fn(),
    continueRound: vi.fn(() => Promise.resolve()),
    expandOne: vi.fn(() => Promise.resolve()),
    runToPrototype: vi.fn(),
    runFromDevelop: vi.fn(),
    stopLoop: vi.fn(),
    dismissLoop: vi.fn(),
    isSessionLive: vi.fn(() => false),
    dispose: vi.fn(),
  }
}

describe('PopupPanel', () => {
  it('opens the workflow, records project information, and adds a requirement', () => {
    render(<PopupPanel controller={controller()} t={makeTranslate(zh)} />)

    fireEvent.click(screen.getByRole('button', { name: '需求面板' }))
    expect(screen.getByRole('dialog', { name: '项目流程面板' })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('字段名，例如：后端框架'), {
      target: { value: '后端框架' },
    })
    fireEvent.change(screen.getByPlaceholderText('字段值，例如：springboot'), {
      target: { value: 'Spring Boot' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('后端框架')).toBeTruthy()
    expect(screen.getByText('Spring Boot')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '需求' }))
    fireEvent.change(screen.getByPlaceholderText('手动添加需求，例如：开发一个 CRM'), {
      target: { value: '开发一个 CRM' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('开发一个 CRM')).toBeTruthy()
  })
})
