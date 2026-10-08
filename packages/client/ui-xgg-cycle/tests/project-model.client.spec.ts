import { describe, expect, it } from 'vitest'
import {
  buildDevelopContext, buildExpandPrompt, buildFixContext, buildPrototypeContext,
  buildReleaseContext, buildTestContext, EMPTY_SERVER,
  type BugItem, type Requirement,
} from '../src/client/project-model.ts'

const requirement: Requirement = {
  id: 'requirement-1',
  text: '为现有客户模块增加批量导入',
  expanded: false,
  modules: [],
}

const bug: BugItem = {
  id: 'bug-1',
  title: '导入失败后没有错误提示',
  detail: '上传错误格式的文件',
  severity: 'P1',
  status: 'open',
  createdAt: 1,
}

function expectOrientationBefore(context: string, phaseMarker: string): void {
  const orientation = context.indexOf('【项目梳理】（先完成，再开始本轮任务）')
  expect(orientation).toBeGreaterThanOrEqual(0)
  expect(orientation).toBeLessThan(context.indexOf(phaseMarker))
  expect(context).toContain('现有未提交改动属于用户，必须保留')
  expect(context).toContain('已有能力只补缺口并沿用现有结构')
}

describe('xgg-cycle project orientation', () => {
  it('surveys the repository read-only before expanding a requirement', () => {
    const prompt = buildExpandPrompt([], [requirement])

    expectOrientationBefore(prompt, '【需求列表】')
    expect(prompt).toContain('先只读梳理当前仓库')
    expect(prompt).toContain('本轮只做只读梳理和需求规划')
    expect(prompt).not.toContain('不要碰仓库')
  })

  it('orients every phase before its phase-specific rules', () => {
    const contexts = [
      [buildPrototypeContext([], [requirement], [], 'full', '', 1, false), '【开发约定】'],
      [buildDevelopContext([], [requirement], [], '', true, undefined, 1), '【开发约定】'],
      [buildTestContext([], [requirement], [], '', true, undefined, 1, []), '【测试约定】'],
      [buildFixContext([bug], 1, undefined), '【修复约定】'],
      [buildReleaseContext('', 'cloudflare', EMPTY_SERVER, '', 1, undefined, true), '【上线约定】'],
    ] as const

    for (const [context, phaseMarker] of contexts) expectOrientationBefore(context, phaseMarker)
  })
})
