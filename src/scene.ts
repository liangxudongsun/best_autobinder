//@ts-nocheck
import { readFileSync, writeFileSync } from "fs-extra";
import * as ts from 'typescript';
import Const from "./Const";
import { join } from 'path';
// 临时在当前模块增加编辑器内的模块为搜索路径，为了能够正常 require 到 cc 模块，后续版本将优化调用方式
module.paths.push(join(Editor.App.path, 'node_modules'));

// 当前版本需要在 module.paths 修改后才能正常使用 cc 模块
// 并且如果希望正常显示 cc 的定义，需要手动将 engine 文件夹里的 cc.d.ts 添加到插件的 tsconfig 里
// 当前版本的 cc 定义文件可以在当前项目的 temp/declarations/cc.d.ts 找到
import { director, Component, Node } from 'cc';
const DebugLog = false;
const logger = (args) => {
    if (DebugLog) {
        console.log('【Best AutoBinder】:', args);
    }
}

// ============= 类型映射服务 =============
class TypeMapper {
    // 预计算映射表
    private static fullToShort = new Map<string, string>();      // cc.Label -> Label (用于 import 和 property)
    private static fullToProperty = new Map<string, string>();    // cc.Label -> Label
    private static fullToImport = new Map<string, string>();    // cc.sp.Skeleton -> sp
    private static ccTypeToKeys = new Map<string, string[]>();    // cc.Node -> [Node, autoNode, MyNode]
    private static typeToKey = new Map<string, string>();         // ToggleContainer -> ToggleGroup (反向映射)

    static {
        // 构建映射表
        const entries = Object.entries(Const.SeparatorMap) as [string, string][];
        for (const [key, full] of entries) {
            const parts = full.split('.');

            // full -> short (用于 import，始终使用内置短类型)
            const builtinShort = parts.length >= 3 ? `${parts[1]}.${parts[2]}` : parts[1];
            this.fullToShort.set(full, builtinShort);

            // full -> property type
            const propType = parts.length >= 3 ? `${parts[1]}.${parts[2]}` : parts[1];
            this.fullToProperty.set(full, propType);

            // full -> import module
            if (parts[1]) this.fullToImport.set(full, parts[1]);

            // ccType -> keys (同 ccType 的所有 key)
            if (!this.ccTypeToKeys.has(full)) this.ccTypeToKeys.set(full, []);
            this.ccTypeToKeys.get(full)!.push(key);

            // 反向映射: property type -> key
            this.typeToKey.set(propType, key);
        }
    }

    /** 短类型 -> 完整类型 */
    static toFull(type: string): string {
        return Const.SeparatorMap[type] || type;
    }

    /** 完整类型 -> 短类型 */
    static toShort(full: string): string {
        return this.fullToShort.get(full) || (full.startsWith('cc.') ? full.slice(3) : full);
    }

    /** 获取 @property 装饰器类型 */
    static getPropertyType(full: string): string {
        return this.fullToProperty.get(full) || this.toShort(full);
    }

    /** 获取 import 模块名 */
    static getImportModule(full: string): string | null {
        return this.fullToImport.get(full) || null;
    }

    /** 获取节点搜索用的所有可能 key */
    static getSearchKeys(propType: string): string[] {
        // 如果 propType 本身就是 SeparatorMap 的 key，直接返回
        if (Const.SeparatorMap[propType]) {
            const full = this.toFull(propType);
            return this.ccTypeToKeys.get(full) || [propType];
        }
        // 否则从反向映射查找
        const key = this.typeToKey.get(propType);
        if (key) {
            const full = this.toFull(key);
            return this.ccTypeToKeys.get(full) || [key];
        }
        return [propType];
    }

    /** 获取组件查找的所有可能类型名 */
    static getComponentTypes(full: string): string[] {
        const types: string[] = [];
        const parts = full.split('.');

        if (parts.length === 2) types.push(parts[1], full);
        else if (parts.length >= 3) types.push(parts.slice(1).join('.'), full);
        else types.push(full);

        // 添加 SeparatorMap 中同 ccType 的所有 key
        const keys = this.ccTypeToKeys.get(full);
        if (keys) types.push(...keys);

        // 如果没有任何内置类型匹配，添加自定义组件名
        if (types.length === 0 || (types.length === 1 && types[0] === full)) {
            types.push(full);
        }

        return [...new Set(types)];
    }
}

// ============= 属性解析服务 =============
class PropertyParser {
    /** 使用 TypeScript AST 解析 @property 装饰器 */
    static parseContent(content: string): any[] {
        const props: Map<string, any> = new Map();

        // 解析 TypeScript 源代码为 AST
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        // 遍历 AST 节点
        const visit = (node: ts.Node) => {
            // 检查是否是装饰器
            if (ts.isDecorator(node)) {
                const decorator = this.parseDecorator(node);
                if (decorator && !props.has(decorator.name)) {
                    props.set(decorator.name, decorator);
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return Array.from(props.values());
    }

    /** 解析单个装饰器节点 */
    private static parseDecorator(node: ts.Decorator): { name: string; type: string; tsType: string } | null {
        const expression = node.expression;

        // 只处理 @property 装饰器
        if (!ts.isCallExpression(expression)) return null;
        const callee = expression.expression;
        if (!ts.isIdentifier(callee) || callee.getText() !== 'property') return null;

        // 解析装饰器参数
        const args = expression.arguments;
        if (args.length === 0) return null;

        // 从参数中提取类型
        let type = 'unknown';
        const firstArg = args[0];

        // 情况1: 直接类型 @property(Type) - 如 EditBox, Label
        if (ts.isIdentifier(firstArg)) {
            type = firstArg.getText();
        }
        // 情况2: 属性访问表达式 @property(sp.Skeleton) 或 @property(dragonBones.ArmatureDisplay)
        else if (ts.isPropertyAccessExpression(firstArg)) {
            type = firstArg.getText();
        }
        // 情况3: 对象参数 @property({ type: Type, ... })
        else if (ts.isObjectLiteralExpression(firstArg)) {
            for (const prop of firstArg.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'type') {
                    const value = prop.initializer;
                    // 支持标识符和属性访问
                    if (ts.isIdentifier(value)) {
                        type = value.getText();
                    } else if (ts.isPropertyAccessExpression(value)) {
                        type = value.getText();
                    }
                    break;
                }
            }
        }
        // 情况4: 数组参数 @property([Type])
        else if (ts.isArrayLiteralExpression(firstArg)) {
            const firstElem = firstArg.elements[0];
            if (ts.isIdentifier(firstElem)) {
                type = firstElem.getText();
            } else if (ts.isPropertyAccessExpression(firstElem)) {
                type = firstElem.getText();
            }
        }

        // 直接通过 parent 获取类属性声明（更可靠）
        const parent = node.parent;
        if (!parent || !ts.isPropertyDeclaration(parent)) return null;

        // 获取属性名
        const nameNode = parent.name;
        if (!nameNode || !ts.isIdentifier(nameNode)) return null;
        const name = nameNode.getText();

        // 获取 TypeScript 类型
        let tsType = type;
        const typeNode = parent.type;
        if (typeNode) {
            if (ts.isTypeReferenceNode(typeNode)) {
                tsType = typeNode.getText();
            } else {
                tsType = typeNode.getText();
            }
        }

        return { name, type, tsType };
    }

    static async parseFromFile(url: string): Promise<any[]> {
        const path = url.replace('db://', Editor.Project.path + '/').replace(/\\/g, '/');
        try {
            const content = readFileSync(path, 'utf-8');
            return this.parseContent(content);
        } catch {
            logger('读取文件失败:', path);
            return [];
        }
    }
}

// ============= 节点查找服务 =============
class NodeFinder {
    static getById(root: Node, id: string): any {
        //@ts-ignore
        return this.findDeep(root, n => n._id === id);
    }

    static getByName(root: Node, name: string): any {
        return this.findDeep(root, n => n.name === name);
    }

    static getByPath(root: any, path: string): any {
        const parts = path.split('/');
        let node = root;
        for (const p of parts) {
            if (!node) return null;
            node = node.children?.find((c: any) => c.name === p);
        }
        return node;
    }

    // 获取节点上自定义组件的导入路径
    static async getComponentPath(root: any, nodeName: string, componentName: string): Promise<string | null> {
        const node = this.getByName(root, nodeName);
        if (!node) return null;

        // 查找节点上的自定义组件
        for (const comp of node.components || []) {
            if (comp.constructor.name === componentName && comp.__scriptUuid) {
                // 使用脚本 UUID 获取资源路径
                const url = await Editor.Message.request('asset-db', 'query-url', comp.__scriptUuid);
                if (url) {
                    // 去掉 .ts 后缀
                    return url.replace(/\.ts$/, '');
                }
            }
        }
        return null;
    }

    // 同步版本：查找节点上的自定义组件
    static findComponentScript(root: any, nodeName: string, componentName: string): any {
        const node = this.getByName(root, nodeName);
        if (!node) return null;

        for (const comp of node.components || []) {
            if (comp.constructor.name === componentName) {
                return comp;
            }
        }
        return null;
    }

    private static findDeep(node: Node, predicate: (n: Node) => boolean): Node | null {
        if (predicate(node)) return node;
        for (const child of node.children || []) {
            const found = this.findDeep(child, predicate);
            if (found) return found;
        }
        return null;
    }

    static getCustomScripts(node: Node): any[] {
        return (node.components || [])
            .filter((c: any) => c.__scriptUuid)
            .map((c: any) => ({
                name: c.constructor.name,
                uuid: c.__scriptUuid,
                id: c.__scriptId
            }));
    }

    static getComponentIndex(node: any, script: any): number {
        const comps = node._components || [];
        return comps.findIndex((c: any) => c.constructor.name === script.__classname__);
    }

    // 检查节点上是否存在指定名称的组件
    static hasComponent(node: Node, componentName: string): boolean {
        for (const comp of node.components || []) {
            if (comp.constructor.name === componentName) {
                return true;
            }
        }
        return false;
    }
}

// ============= 节点名称解析服务 =============
class NodeNameParser {
    static parse(name: string, isRoot: boolean = false): { type: string; prop: string; nodeProp: string; ccType: string; isBuiltin: boolean } | null {
        // 根节点不做解析
        if (isRoot) {
            return null;
        }

        // 以下情况返回 null：
        // 1. 以 _ 开头（私有属性）
        // 2. 不包含 @ 分隔符
        if (name.startsWith('_') || !name.includes(Const.STANDARD_Separator)) return null;

        const [type, rest] = name.split(Const.STANDARD_Separator);
        if (!type || !rest) return null;

        // 原始属性名（用于节点查找）
        // 如果以 # 结尾，去掉 # 后缀
        let nodeProp = rest.endsWith(Const.STANDARD_End) ? rest.slice(0, -1) : rest;
        // 将属性名中的 - 替换为 _ (TS变量名不允许 - )
        const prop = nodeProp.replace(/-/g, '_');

        // 获取 Cocos 组件类型
        const ccType = this.getCCType(type);
        const isBuiltin = this.isBuiltinType(ccType);

        return { type, prop, nodeProp, ccType, isBuiltin };
    }

    private static getCCType(type: string): string {
        // 先检查是否是 SeparatorMap 的 key
        if (Const.SeparatorMap[type]) return Const.SeparatorMap[type];
        // 再检查是否是 ccType 的后缀
        for (const key of Object.keys(Const.SeparatorMap)) {
            if (Const.SeparatorMap[key].endsWith('.' + type)) return Const.SeparatorMap[key];
        }
        // 不在 SeparatorMap 中，返回 type 本身（可能是自定义组件，如 PlayerName）
        return type;
    }

    /** 判断是否是 Cocos 内置类型（不是自定义组件） */
    static isBuiltinType(type: string): boolean {
        // 检查是否在 SeparatorMap 中
        if (Const.SeparatorMap[type]) return true;
        for (const key of Object.keys(Const.SeparatorMap)) {
            if (Const.SeparatorMap[key] === type) return true;
            if (Const.SeparatorMap[key].endsWith('.' + type)) return true;
        }
        return false;
    }

    static findCandidates(node: any, existing: string[], isRoot: boolean = false): any[] {
        const parsed = this.parse(node.name, isRoot);

        // 解析失败
        if (!parsed) {
            // 根节点：跳过检查，只遍历子节点
            if (isRoot) {
                const children: any[] = [];
                for (const child of node.children || []) {
                    children.push(...this.findCandidates(child, existing, false));
                }
                return children;
            }
            // 非根节点解析失败：不遍历子节点
            return [];
        }

        // 属性名已存在
        if (existing.includes(parsed.prop)) {
            // 如果节点以 # 结尾，说明该节点已确认绑定，不遍历子节点
            if (this.hasEndMark(node.name)) {
                return [];
            }
            // 节点不以 # 结尾，继续遍历子节点查找其他符合条件的节点
            const children: any[] = [];
            for (const child of node.children || []) {
                children.push(...this.findCandidates(child, existing, false));
            }
            return children;
        }

        // 当前节点以 # 结尾：只添加当前节点，不遍历子节点
        if (this.hasEndMark(node.name)) {
            return [{
                nodeName: node.name,
                nodeId: node._id,
                type: parsed.type,
                prop: parsed.prop,
                nodeProp: parsed.nodeProp,
                ccType: parsed.ccType,
                isBuiltin: parsed.isBuiltin
            }];
        }

        // 正常节点：添加当前节点，然后遍历子节点
        const children: any[] = [];
        for (const child of node.children || []) {
            children.push(...this.findCandidates(child, existing, false));
        }

        return [{
            nodeName: node.name,
            nodeId: node._id,
            type: parsed.type,
            prop: parsed.prop,
            nodeProp: parsed.nodeProp,
            ccType: parsed.ccType,
            isBuiltin: parsed.isBuiltin
        }, ...children];
    }

    /** 检查节点名称是否以 # 结尾 */
    static hasEndMark(nodeName: string): boolean {
        return nodeName.endsWith(Const.STANDARD_End);
    }
}

// ============= 脚本修改服务 =============
class ScriptModifier {
    // 添加自定义组件的 import，需要路径
    static addCustomImport(content: string, componentPath: string, componentName: string): string {
        // 检查是否已有 import
        const importRegex = new RegExp(`import\\s+{[^}]*\\b${componentName}\\b[^}]*}\\s+from\\s+['"']`);
        if (importRegex.test(content)) {
            return content;
        }

        // 添加 import 语句
        const importStatement = `import { ${componentName} } from '${componentPath}';\n`;
        const pos = content.match(/^import\s+/m)?.index;
        if (pos !== undefined) {
            return content.slice(0, pos) + importStatement + content.slice(pos);
        }
        return importStatement + content;
    }

    static ensureBuiltinImports(content: string, types: string[]): string {
        const ccTypes: string[] = [];
        const modules = new Set<string>();

        for (const type of types) {
            // 处理模块类型: sp.Skeleton -> module=sp, shortType=Skeleton
            let module: string | null = null;
            let shortType = type;

            if (type.includes('.')) {
                const parts = type.split('.');
                module = parts[0];
                shortType = parts.slice(1).join('.');
            }

            // 尝试从 SeparatorMap 查找完整类型
            let fullType: string | undefined;
            for (const [key, full] of Object.entries(Const.SeparatorMap)) {
                const parts = full.split('.');
                const builtinShort = parts.length >= 3 ? `${parts[1]}.${parts[2]}` : parts[1];
                if (builtinShort === shortType || key === shortType || full.endsWith('.' + shortType)) {
                    fullType = full;
                    break;
                }
            }

            if (module) {
                if (fullType && fullType.includes('.')) {
                    modules.add(module);
                } else {
                    ccTypes.push(shortType);
                }
            } else {
                ccTypes.push(shortType);
            }
        }

        return this.addCCImport(content, [...new Set([...ccTypes, ...modules])]);
    }

    private static addCCImport(content: string, parts: string[]): string {
        const match = content.match(/import\s*{([^}]*)}\s*from\s*['"]cc['"]/);
        if (!match) {
            const pos = content.match(/^import\s+/m)?.index;
            return pos !== undefined
                ? content.slice(0, pos) + `import { ${parts.join(', ')} } from 'cc';\n` + content.slice(pos)
                : `import { ${parts.join(', ')} } from 'cc';\n` + content;
        }

        const existing = match[1].split(',').map(s => s.trim()).filter(Boolean);

        // 提取现有的模块名（如 dragonBones, sp, animation）
        const existingModules = new Set<string>();
        for (const item of existing) {
            if (!item.includes('.')) {
                existingModules.add(item);
            }
        }

        // 过滤掉已经以模块方式导入的项
        const missing = parts.filter(p => {
            // 如果是模块类型（如 dragonBones），检查是否已存在
            if (p.includes('.')) {
                const module = p.split('.')[0];
                return !existingModules.has(module) && !existing.includes(p);
            }
            return !existing.includes(p);
        });

        return missing.length
            ? content.replace(match[0], `import { ${[...existing, ...missing].join(', ')} } from 'cc'`)
            : content;
    }

    static insertProperty(content: string, decl: string): string {
        const classMatch = content.match(/export\s+(?:default\s+)?class\s+\w+\s+extends\s+[\s\S]*?\s*{/);
        if (classMatch) {
            const pos = classMatch.index! + classMatch[0].length;
            return content.slice(0, pos) + '\n' + decl + content.slice(pos);
        }
        return content + decl;
    }

    static generate(prop: string, ccType: string): string {
        return `\n\t@property(${TypeMapper.getPropertyType(ccType)}) ${prop}!: ${TypeMapper.getPropertyType(ccType)};\n`;
    }
}

// ============= 绑定服务 =============
class SceneBinder {
    static async bindProperty(root: Node, script: any, prop: any): Promise<any> {
        if (prop.name.startsWith('_')) return null;

        const ccType = TypeMapper.toFull(prop.type);
        const searchKeys = TypeMapper.getSearchKeys(prop.type);

        // 尝试多个 key 查找节点
        let target = this.findNode(root, searchKeys, prop.name);
        if (!target) {
            // 5. 节点命名不符合规范被跳过
            logger(`【5】属性 ${prop.name} 未能找到匹配的节点 (搜索键: ${searchKeys.join(', ')})`);
            return null;
        }

        // cc.Node 类型特殊处理：直接返回节点本身
        if (ccType === 'cc.Node') {
            script[prop.name] = target;
            // 4. 哪些节点绑定成功
            const compIdx = NodeFinder.getComponentIndex(root, script);
            const targetUuid = target._id;
            const rootUuid = root.uuid || root._id;
            await this.setPropertyDumpWithType(rootUuid, `__comps__.${compIdx}.${prop.name}`, ccType, targetUuid);
            logger(`【4】绑定成功: ${prop.name} -> 节点 ${target.name}`);

            return { prop: prop.name, type: ccType, nodeName: target.name, nodeId: target._id };
        }

        // 尝试多种类型获取组件
        const compTypes = TypeMapper.getComponentTypes(ccType);
        const value = this.findComponent(target, compTypes);
        if (!value) {
            // 输出节点上所有组件名称帮助调试
            const compNames = (target.components || []).map((c: any) => c.constructor.name);
            logger(`${target.name}，查找到脚本：[${compNames}]`)
            return null;
        }

        script[prop.name] = value;
        await this.setPropertyDump(root, script, prop, ccType);

        // 4. 哪些节点绑定成功
        logger(`【4】绑定成功: ${prop.name} -> 节点 ${target.name} (组件: ${value.constructor.name})`);

        return { prop: prop.name, type: ccType, nodeName: target.name, nodeId: target._id };
    }
    // ============= 属性设置服务（统一封装 set-property 调用）=============
    private static async setPropertyDump(root: any, script: any, prop: any, ccType: string): Promise<void> {
        const compIdx = NodeFinder.getComponentIndex(root, script);
        if (compIdx < 0) return;

        const targetUuid = script[prop.name]._id;
        const rootUuid = root.uuid || root._id;
        const typeShort = TypeMapper.toShort(ccType);
        const dump = { type: typeShort, value: { uuid: targetUuid } };
        await Editor.Message.request('scene', 'set-property', {
            uuid: rootUuid,
            path: `__comps__.${compIdx}.${prop.name}`,
            dump
        });
    }

    private static async setPropertyDumpWithType(uuid: string, path: string, type: string, targetUuid: string): Promise<void> {
        const dump = { type, value: { uuid: targetUuid } };
        await Editor.Message.request('scene', 'set-property', {
            uuid,
            path,
            dump
        });
    }


    private static findNode(root: Node, keys: string[], prop: string): any {
        for (const key of keys) {
            // 原始属性名
            let node = NodeFinder.getByName(root, `${key}@${prop}`);
            if (!node) node = NodeFinder.getByName(root, `${key}@${prop}${Const.STANDARD_End}`);
            if (node) return node;

            // 将 _ 替换为 - (TS变量名 labtest_001 -> 节点名 labtest-001)
            const propWithDash = prop.replace(/_/g, '-');
            node = NodeFinder.getByName(root, `${key}@${propWithDash}`);
            if (!node) node = NodeFinder.getByName(root, `${key}@${propWithDash}${Const.STANDARD_End}`);
            if (node) return node;

            // 自定义组件: 没有前缀，直接用 prop 查找（如 PlayerName@playerName）
            if (key === prop) continue;
            node = NodeFinder.getByName(root, prop);
            if (node) return node;
            node = NodeFinder.getByName(root, `${prop}${Const.STANDARD_End}`);
            if (node) return node;
        }
        return null;
    }

    private static findComponent(node: any, types: string[]): any {
        // 遍历节点组件匹配
        for (const comp of node.components || []) {
            const compName = comp.constructor.name;
            if (types.includes(compName)) return comp;
        }
        // 回退到 getComponent
        for (const t of types) {
            const c = node.getComponent(t);
            if (c) return c;
        }
        return null;
    }

    // 验证自定义组件候选列表（过滤掉节点不存在或组件不存在的候选）
    private static validateCustomCandidates(root: any, candidates: any[]): { valid: any[]; invalid: any[] } {
        const valid: any[] = [];
        const invalid: any[] = [];
        for (const c of candidates) {
            const target = NodeFinder.getByName(root, c.nodeName);
            if (!target) {
                console.warn(`[UIBinder] 警告：节点 "${c.nodeName}" 未找到，跳过声明`);
                invalid.push(c);
            } else if (!NodeFinder.hasComponent(target, c.ccType)) {
                console.warn(`[UIBinder] 警告：节点 "${c.nodeName}" 上未找到组件 "${c.ccType}"，跳过声明`);
                invalid.push(c);
            } else {
                valid.push(c);
            }
        }
        return { valid, invalid };
    }

    // 为自定义组件添加 import 语句
    private static async addCustomImports(root: any, content: string, candidates: any[]): Promise<string> {
        for (const c of candidates) {
            const compPath = await NodeFinder.getComponentPath(root, c.nodeName, c.ccType);
            const path = compPath ? compPath.replace(/\.ts$/, '') : `db://assets/Script/Component/${c.ccType}`;
            content = ScriptModifier.addCustomImport(content, path, c.ccType);
        }
        return content;
    }

    // 生成新属性声明并返回更新的内容和属性列表
    private static generateNewProperties(content: string, candidates: any[]): { content: string; props: any[] } {
        const props: any[] = [];
        for (const c of candidates) {
            const decl = ScriptModifier.generate(c.prop, c.ccType);
            content = ScriptModifier.insertProperty(content, decl);
            props.push({ prop: c.prop, type: TypeMapper.getPropertyType(c.ccType), nodeName: c.nodeName });
        }
        return { content, props };
    }

    // 绑定新创建的属性到场景
    private static async bindNewProperties(root: any, comp: any, candidates: any[]): Promise<void> {
        const compIdx = NodeFinder.getComponentIndex(root, comp);
        if (compIdx < 0) {
            logger(`未找到脚本组件索引: ${comp.constructor.name}`);
            return;
        }
        for (const c of candidates) {
            const target = NodeFinder.getByName(root, c.nodeName);
            if (!target) {
                logger(`[bindNewProperties] 未找到目标节点: ${c.nodeName}`);
                continue;
            }
            const targetUuid = target.uuid || target._id;
            const rootUuid = root.uuid || root._id;
            const typeShort = TypeMapper.toShort(c.ccType);

            logger(`[bindNewProperties] 开始绑定: rootUuid=${rootUuid}, targetUuid=${targetUuid}, path=__comps__.${compIdx}.${c.prop}`);

            // 方式1: 使用根节点 uuid
            await Editor.Message.request('scene', 'set-property', {
                uuid: rootUuid,
                path: `__comps__.${compIdx}.${c.prop}`,
                dump: { type: typeShort, value: { uuid: targetUuid } }
            });

            // 方式2: 如果目标是预制体实例，尝试直接设置属性值
            if (rootUuid !== targetUuid) {
                await Editor.Message.request('scene', 'set-property', {
                    uuid: targetUuid,
                    path: `__comps__.0.${c.prop}`,
                    dump: { type: typeShort, value: { uuid: targetUuid } }
                });
            }
        }
    }

    // 查找候选节点
    private static findCandidateNodes(root: any, propNames: string[]): any[] {
        const candidates = NodeNameParser.findCandidates(root, propNames, true);
        if (!candidates.length) return [];
        // 过滤掉已存在的属性名
        const newCandidates = candidates.filter((c: any) => !propNames.includes(c.prop));
        logger(`待声明节点 : ${newCandidates.map(c => c.nodeName).join(', ')}`);
        return newCandidates;
    }

    // 读取脚本文件内容
    private static readScriptContent(url: string): string | null {
        if (!url) return null;
        const path = url.replace('db://', Editor.Project.path + '/').replace(/\\/g, '/');
        return readFileSync(path, 'utf-8');
    }

    // 分离内置类型和自定义组件
    private static separateCandidateTypes(candidates: any[]): { builtin: any[]; custom: any[] } {
        const builtin = candidates.filter((c: any) => c.isBuiltin);
        const custom = candidates.filter((c: any) => !c.isBuiltin);
        return { builtin, custom };
    }

    // 处理内置类型的 import
    private static processBuiltinImports(content: string, builtinCandidates: any[]): string {
        const builtinTypes = [...new Set(builtinCandidates.map((c: any) => TypeMapper.toShort(c.ccType)))];
        return ScriptModifier.ensureBuiltinImports(content, builtinTypes);
    }

    // 生成新属性声明
    private static createNewProperties(content: string, candidates: any[]): { content: string; props: any[] } {
        const result = this.generateNewProperties(content, candidates);
        logger(`TS脚本新属性声明完成:`);
        console.log(result.props)
        return result;
    }

    // 保存脚本文件
    private static saveScriptContent(url: string, content: string): void {
        const path = url.replace('db://', Editor.Project.path + '/').replace(/\\/g, '/');
        writeFileSync(path, content, 'utf-8');
    }

    // 重新导入脚本资源
    private static async reimportScript(uuid: string): Promise<void> {
        try {
            await Editor.Message.request('asset-db', 'reimport-asset', uuid);
        } catch { }
        await new Promise(r => setTimeout(r, 500));
    }

    // 重新获取组件实例
    private static getReimportedComponent(root: any, scriptName: string): any {
        return root.getComponent(scriptName);
    }

    static async scanAndCreate(root: any, script: any, existing: any[]): Promise<any[]> {
        // 1. 获取脚本路径
        const url = await Editor.Message.request('asset-db', 'query-url', script.uuid);
        if (!url) return [];

        // 2. 获取属性名列表
        const propNames = existing.map((p: any) => p.name);

        // 3. 查找候选节点
        const newCandidates = this.findCandidateNodes(root, propNames);
        if (!newCandidates.length) return [];

        // 4. 读取脚本内容
        let content = this.readScriptContent(url);
        if (!content) return [];

        // 5. 分离内置类型和自定义组件
        const { builtin: builtinCandidates, custom: customCandidates } = this.separateCandidateTypes(newCandidates);

        // 6. 处理内置类型的 import
        content = this.processBuiltinImports(content, builtinCandidates);

        // 7. 处理自定义组件的 import 并获取验证后的候选
        const { valid: validCustomCandidates } = this.validateCustomCandidates(root, customCandidates);
        content = await this.addCustomImports(root, content, validCustomCandidates);

        // 8. 合并有效候选并生成新属性声明
        const validCandidates = [...builtinCandidates, ...validCustomCandidates];
        const result = this.createNewProperties(content, validCandidates);
        content = result.content;
        const newProps = result.props;

        // 9. 保存脚本文件
        this.saveScriptContent(url, content);

        // 10. 重新导入并绑定
        await this.reimportScript(script.uuid);

        // 11. 重新获取组件实例
        const comp = this.getReimportedComponent(root, script.name);
        if (!comp) {
            return newProps;
        }

        // 12. 绑定新属性
        await this.bindNewProperties(root, comp, newCandidates);

        return newProps;
    }
}

// ============= 编辑器接口 =============
export const methods = {


    async bind(...args: any[]) {
        const root = director.getScene();
        let ids: string[] = [];
        if (args.length > 0 && Array.isArray(args[0])) {
            ids = args[0];
        } else {
            ids = Editor.Selection.getSelected('node') || [];
        }

        if (!ids.length) { logger('未选中任何节点！'); return; }

        // 获取所有需要处理的根节点（去重）
        const uniqueIds = [...new Set(ids)];

        const bound: any[] = [];
        const created: any[] = [];

        for (const id of uniqueIds) {
            const node = NodeFinder.getById(root, id);
            if (!node) continue;
            // 1. 当前选中的节点
            logger(`【1】当前选中的节点：${node.name} (id: ${id})`);
            for (const script of NodeFinder.getCustomScripts(node)) {
                const url = await Editor.Message.request('asset-db', 'query-url', script.uuid);
                const props = url ? await PropertyParser.parseFromFile(url) : [];
                const comp = node.getComponent(script.name);
                if (!comp) continue;
                // 2. 当前选中节点的哪个自定义脚本
                logger(`【2】正在处理脚本：${script.name}`);

                for (const p of props) {
                    const r = await SceneBinder.bindProperty(node, comp, p);
                    if (r) bound.push(r);
                }

                // 扫描并创建新属性
                const newProps = await SceneBinder.scanAndCreate(node, script, props);
                created.push(...newProps);
            }

            // 对根节点下的所有子节点也执行扫描（处理子节点的脚本组件）
            for (const child of node.children || []) {
                await this.processNodeAndDescendants(child, bound, created);
            }
        }
        if (bound.length && created.length) {
            logger(`绑定完成！已绑定 ${bound.length} 个属性，新增 ${created.length} 个属性`);
        } else if (bound.length) {
            logger(`绑定完成！已绑定 ${bound.length} 个属性`);
        } else if (created.length) {
            logger(`绑定完成！新增 ${created.length} 个属性`);
        } else {
            logger('未找到任何可绑定的属性！');
        }

        if (ids.length) {
            const type = Editor.Selection.getLastSelectedType();
            Editor.Selection.unselect(type, ids);
            Editor.Selection.select(type, ids);
            await Editor.Message.request('scene', 'soft-reload');
        }

        return { bindResults: bound, newProperties: created };
    },


    // 递归处理节点及其所有后代节点
    async processNodeAndDescendants(node: any, bound: any[], created: any[]): Promise<void> {
        // 处理当前节点的脚本
        for (const script of NodeFinder.getCustomScripts(node)) {
            const url = await Editor.Message.request('asset-db', 'query-url', script.uuid);
            const props = url ? await PropertyParser.parseFromFile(url) : [];
            const comp = node.getComponent(script.name);
            if (!comp) continue;

            // 2. 当前选中节点的哪个自定义脚本
            logger(`【2】正在处理脚本: ${script.name} (节点: ${node.name})`);

            for (const p of props) {
                const r = await SceneBinder.bindProperty(node, comp, p);
                if (r) bound.push(r);
            }

            const newProps = await SceneBinder.scanAndCreate(node, script, props);
            created.push(...newProps);
        }

        // 递归处理所有子节点
        for (const child of node.children || []) {
            await this.processNodeAndDescendants(child, bound, created);
        }
    }


};
