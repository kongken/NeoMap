/** 表单控件的 aria-describedby：优先指向错误信息，其次提示 */
export const describedBy = (id: string, error?: string, hint?: string) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined)
