import { ReviewFields, ReviewInput } from '../domain/model';

export interface FormData extends ReviewInput, ReviewFields {}
export type PluginMode = 'minimal' | 'full';
export interface RepositorySettings { mode?: PluginMode; rbtPath?: string; timeoutSeconds?: number; notificationsEnabled?: boolean; pollIntervalSeconds?: number; }
export interface StateStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}
export function initialForm(server = ''): FormData {
    return { server, repositoryId: null, targetRef: '', baseRef: '', mode: 'bound', reviewId: null,
        summary: '', description: '', testing: '', people: [], groups: [], bugs: [], branch: '', changeDescription: '' };
}
const preferenceFields = ['server', 'repositoryId', 'targetRef', 'baseRef', 'mode', 'people', 'groups', 'bugs'] as const;

/** Canonical repository root scopes global state across VS Code workspaces/windows. */
export class RepositoryStore {
    private readonly prefix: string;
    constructor(readonly root: string, private readonly state: StateStorage, private readonly legacy?: StateStorage) {
        this.prefix = `repository:v2:${root}:`;
    }
    async initialize(): Promise<void> {
        if (!this.get('ownForm')) {
            const old = this.legacy?.get<FormData>(`form:${this.root}`);
            if (old) { await this.set('ownForm', old); await this.saveDefaults(old); }
        }
        if (!this.get('threeDiffModes')) {
            for (const key of ['ownForm', 'defaults']) {
                const value = this.get<Partial<FormData>>(key);
                if (value && this.get('finalDiffDefaults') && value.mode === 'squash') { await this.set(key, { ...value, mode: 'bound' }); }
            }
            await this.set('threeDiffModes', true);
        }
        if (!this.get('submissionPending')) {
            const old = this.legacy?.get(`pending:${this.root}`);
            if (old) { await this.set('submissionPending', old); await this.legacy!.update(`pending:${this.root}`, undefined); }
        }
    }
    get<T>(key: string): T | undefined { return this.state.get<T>(this.prefix + key); }
    async set(key: string, value: unknown): Promise<void> { await this.state.update(this.prefix + key, value); }
    form(fallbackServer = ''): FormData {
        return structuredClone({ ...initialForm(fallbackServer), ...this.get<Partial<FormData>>('defaults'), ...this.get<FormData>('ownForm') });
    }
    async saveOwn(form: FormData, updateDefaults = true): Promise<void> {
        await this.set('ownForm', structuredClone(form));
        if (updateDefaults) { await this.saveDefaults(form); }
    }
    private async saveDefaults(form: FormData): Promise<void> {
        const defaults: Partial<FormData> = {};
        for (const key of preferenceFields) { Object.assign(defaults, { [key]: structuredClone(form[key]) }); }
        await this.set('defaults', defaults);
    }
    newForm(): FormData { return structuredClone({ ...initialForm(), ...this.get<Partial<FormData>>('defaults') }); }
    settings(): RepositorySettings { return { ...this.get<RepositorySettings>('settings') }; }
}
