import * as vscode from 'vscode';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RBToolsAdapter } from '../adapters/rbtools';

export interface Recipients { people: string[]; groups: string[]; }
interface RecipientItem extends vscode.QuickPickItem { value: string; kindOfRecipient: 'people' | 'groups'; }

/** Native searchable multi-select; selected users survive server-side filtering. */
export function pickRecipients(backend: RBToolsAdapter, current: Recipients, log: vscode.LogOutputChannel): Promise<Recipients | undefined> {
    return new Promise(resolve => {
        const picker = vscode.window.createQuickPick<RecipientItem>();
        picker.title = 'Reviewers'; picker.placeholder = 'Search people or groups'; picker.canSelectMany = true; picker.ignoreFocusOut = true;
        let selected = current, generation = 0, updating = false, complete = false, timer: ReturnType<typeof setTimeout> | undefined;
        let operation: AbortController | undefined;
        const item = (value: string, kind: 'people' | 'groups', description?: string): RecipientItem => ({ label: `${kind === 'people' ? '$(account)' : '$(organization)'} ${value}`, value, kindOfRecipient: kind, description });
        const load = async (query: string) => {
            const version = ++generation; operation?.abort(); operation = new AbortController(); picker.busy = true;
            try {
                const [users, groups] = await Promise.all([
                    backend.api<{ users: { username: string; fullname: string; is_active: boolean }[] }>('/users/', { q: query, 'max-results': '100' }, operation.signal),
                    backend.api<{ groups: { name: string; display_name: string }[] }>('/groups/', { q: query, 'max-results': '100' }, operation.signal),
                ]);
                if (version !== generation || complete) { return; }
                const items = [...selected.people.map(value => item(value, 'people')), ...selected.groups.map(value => item(value, 'groups')),
                    ...users.users.filter(user => user.is_active).map(user => item(user.username, 'people', user.fullname)),
                    ...groups.groups.map(group => item(group.name, 'groups', group.display_name))];
                const unique = [...new Map(items.map(value => [`${value.kindOfRecipient}:${value.value}`, value])).values()];
                updating = true; picker.items = unique;
                picker.selectedItems = unique.filter(value => selected[value.kindOfRecipient].includes(value.value)); updating = false;
            } catch (error) { if (version === generation && !complete && !operation.signal.aborted) { log.error('Reviewer search failed', error); } }
            finally { if (version === generation && !complete) { picker.busy = false; } }
        };
        const listeners = [
            picker.onDidChangeValue(value => { clearTimeout(timer); timer = setTimeout(() => { void load(value); }, 180); }),
            picker.onDidChangeSelection(items => { if (!updating) { selected = { people: items.filter(value => value.kindOfRecipient === 'people').map(value => value.value), groups: items.filter(value => value.kindOfRecipient === 'groups').map(value => value.value) }; } }),
            picker.onDidAccept(() => { complete = true; resolve(structuredClone(selected)); picker.hide(); }),
            picker.onDidHide(() => { complete = true; generation++; operation?.abort(); clearTimeout(timer); resolve(undefined); listeners.forEach(value => value.dispose()); picker.dispose(); }),
        ];
        picker.show(); void load('');
    });
}

/** Multiline input uses the native editor and standard Save gesture. */
export class NativeInputs implements vscode.Disposable {
    private readonly bindings = new Map<string, { save: (text: string) => Promise<void>; owner?: string; name: string }>();
    private readonly saved: vscode.Disposable;
    constructor(private readonly storage: string, private readonly log: vscode.LogOutputChannel) {
        this.saved = vscode.workspace.onDidSaveTextDocument(document => {
            const binding = this.bindings.get(document.uri.toString());
            if (binding) { void binding.save(document.getText()).catch(error => { this.log.error('Could not save input', error); }); }
        });
    }
    hasOpen(owner: string, prefix: string): boolean {
        return vscode.workspace.textDocuments.some(document => {
            const binding = this.bindings.get(document.uri.toString());
            return binding?.owner === owner && binding.name.startsWith(prefix);
        });
    }
    async edit(name: string, content: string, save: (text: string) => Promise<void>, owner?: string): Promise<void> {
        const inputs = path.join(this.storage, 'inputs'); await mkdir(inputs, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(path.join(inputs, 'edit-')), filename = path.join(directory, name + '.md');
        await writeFile(filename, content, { mode: 0o600 });
        const uri = vscode.Uri.file(filename); let queue = Promise.resolve();
        this.bindings.set(uri.toString(), { owner, name, save: async text => {
            if (text.length > 200_000 || text.includes('\0')) { throw new Error('Input is too long or contains NUL.'); }
            queue = queue.catch(() => {}).then(() => save(text)); await queue;
        } });
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
        vscode.window.setStatusBarMessage('Save to apply changes', 4000);
    }
    dispose(): void { this.saved.dispose(); this.bindings.clear(); }
}
