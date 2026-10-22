/**
 * IKanBot UI 组件库。
 *
 * 目的：把全站重复的视觉与交互收敛到一处，改一次全局生效。
 * 规范来源：docs/ui/design-system.md
 *
 * 用法：
 *   import { Button, Card, Field, Input, StatusTag, Alert } from '../ui'
 */
export { Button, type ButtonVariant, type ButtonSize } from './Button'
export { Card, CardBody } from './Card'
export { Field, Input, Select, Textarea } from './Field'
export { Alert, type AlertKind } from './Alert'
export {
  StatusTag,
  PaymentTag,
  ShipTag,
  QuotationStatusTag,
  SampleStatusTag,
  SampleFeeTag,
  SAMPLE_FEE_LABEL,
  type StatusTone
} from './StatusTag'
export { Row, Spacer, FieldRow, KeyValue, TableWrap, DataTable, Progress } from './Layout'
