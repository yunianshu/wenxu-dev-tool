import assert from 'node:assert/strict'
import {
  buildKnowledgeInsightRequest, parseKnowledgeInsights, knowledgeInsightMarkdown,
  MAX_INSIGHT_PROJECTS, MAX_INSIGHT_RECORDS,
} from '../src/utils/knowledge-insights.js'

const projects = [
  { id: 'private-project-a', name: '租赁', description: '租约变更需要审批', localPath: '禁止外发的路径' },
  { id: 'private-project-b', name: '采购', notes: '采购单按金额分级审批', targets: [{ password: '禁止外发的凭据' }] },
]
const idea = { id: 'private-record', title: '让审批过程透明', body: '被退回的租约要能追溯原因', projectId: projects[0].id }
const { messages, sources } = buildKnowledgeInsightRequest({
  projects: [...projects, projects[0]], records: [idea, { ...idea, id: '回收站', deletedAt: 123, body: '禁止外发的已删记录' }],
  commitsByProject: { [projects[0].id]: ['支持租约撤回'], '未选项目': ['禁止外发的未选提交'] },
})

assert.deepEqual(messages.map(message => message.role), ['system', 'user'])
assert.doesNotMatch(messages[1].content, /private-|禁止外发|password|localPath/)
const material = JSON.parse(messages[1].content)
assert.deepEqual(material.map(item => item.key), ['P1', 'P2', 'R1'])
assert.deepEqual(material[0].commits, ['支持租约撤回'])
assert.equal(material[2].project, 'P1')
assert.equal(material[2].body, idea.body)
assert.throws(() => buildKnowledgeInsightRequest(), /至少选择/)
console.log('✓ 所选资料去重、回收站隔离、本地 ID 与未选及敏感字段隔离')

const moduleCard = {
  title: '审批状态流转', summary: '租赁与采购都需要记录审批状态，各自保留审批条件。',
  nextStep: '分别画出租约与采购单的状态变化。', validation: '两种单据的撤回都能在同一状态模型中表示。',
  sources: ['P1', 'P2'], evidence: { P1: '支持租约撤回', P2: '按金额分级审批' },
}
const actionCard = { ...moduleCard, title: '先核验退回原因', sources: ['R1'] }
function result(modules = [], directions = [], note = '', refs = sources) {
  const json = JSON.stringify({ modules, directions, note })
  return parseKnowledgeInsights('```json\n' + json + '\n```', refs)
}
const valid = result([moduleCard], [actionCard])
assert.equal(valid.modules.length, 1)
assert.deepEqual(valid.modules[0].sources.map(source => source.evidence), ['支持租约撤回', '按金额分级审批'])
assert.deepEqual(valid.directions[0].sources, [{ key: 'R1', kind: 'record', id: idea.id, label: idea.title }])
assert.match(knowledgeInsightMarkdown(valid.modules[0]), /项目 · 采购：按金额分级审批/)
assert.match(knowledgeInsightMarkdown(valid.directions[0]), /## 下一步[\s\S]*## 验证方式[\s\S]*记录 · 让审批过程透明/)
const linked = { ...moduleCard, sources: ['P1', 'P2', 'R1'], evidence: { P1: '租约要能追溯原因', P2: '按金额分级审批' } }
assert.equal(result([linked]).modules.length, 1)
console.log('✓ 模块核对各项目原文、关联记录直接参与举证，建议和保存的正文带上真实来源')

const invalidModules = [
  { ...moduleCard, sources: ['P1', 'P1'] }, { ...moduleCard, sources: ['P1', 'R1'] },
  { ...moduleCard, sources: ['P1', 'P2', 'R9'] }, { ...moduleCard, evidence: {} },
  { ...moduleCard, evidence: { P1: '按金额分级审批', P2: '按金额分级审批' } },
  { ...moduleCard, evidence: { P1: '看不到的内容', P2: '按金额分级审批' } },
  { ...linked, sources: ['P1', 'P2'] }, { ...linked, evidence: { P1: '支持租约撤回', P2: '租约要能追溯原因' } },
]
const rejected = result([...invalidModules, moduleCard], [{ ...actionCard, sources: ['P1'] }, { ...actionCard, validation: '' }, { ...actionCard, sources: ['R99'] }])
assert.deepEqual(rejected.modules, valid.modules)
assert.deepEqual(rejected.directions, [])
assert.match(rejected.note, /已略去/)
assert.match(result().note, /材料不足/)
assert.equal(result([], [], '请补充采购流程。').note, '请补充采购流程。')
assert.throws(() => parseKnowledgeInsights('这是 Markdown', sources), /格式/)
assert.throws(() => parseKnowledgeInsights('{}', sources), /格式/)
assert.throws(() => parseKnowledgeInsights('null', sources), /格式/)
console.log('✓ 排除虚构来源、跨项目错引、未引用的记录及无验证标准的结果，单张失败保留其他有效卡片')

const projectsOnly = buildKnowledgeInsightRequest({ projects })
const recordsOnly = buildKnowledgeInsightRequest({ records: [idea] })
assert.equal(result([], [{ ...actionCard, sources: ['P1'] }], '', projectsOnly.sources).directions.length, 1)
assert.equal(result([moduleCard], [actionCard], '', recordsOnly.sources).modules.length, 0)
assert.equal(result([], [actionCard], '', recordsOnly.sources).directions.length, 1)
const large = '\\"'.repeat(10000)
const manyProjects = Array.from({ length: MAX_INSIGHT_PROJECTS }, (_, i) => ({ id: 'p' + i, name: large, description: large, notes: large, tags: Array(6).fill(large) }))
const manyRecords = Array.from({ length: MAX_INSIGHT_RECORDS }, (_, i) => ({ id: 'r' + i, title: large, body: large, tags: Array(6).fill(large) }))
const long = buildKnowledgeInsightRequest({ projects: manyProjects, records: manyRecords, commitsByProject: Object.fromEntries(manyProjects.map(project => [project.id, Array(8).fill(large)])) })
assert(long.messages[1].content.length < 27000)
assert.equal(JSON.parse(long.messages[1].content).at(-1).key, 'R' + MAX_INSIGHT_RECORDS)
assert.throws(() => buildKnowledgeInsightRequest({ projects: [...manyProjects, ...projects] }), /最多选择/)
assert.throws(() => buildKnowledgeInsightRequest({ records: [...manyRecords, idea] }), /最多选择/)
console.log('✓ 项目或想法可独立使用，大批长文本均分预算且保留最后一份材料')
