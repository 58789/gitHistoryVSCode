import { inject, injectable } from 'inversify';
import * as md5 from 'md5';
import * as osLocale from 'os-locale';
import * as path from 'path';
import { Uri, ViewColumn, window, QuickPickItem } from 'vscode';
import { ICommandManager, IApplicationShell } from '../application/types';
import { IDisposableRegistry } from '../application/types/disposableRegistry';
import { FileCommitDetails, IUiService } from '../common/types';
import { previewUri } from '../constants';
import { IServiceContainer } from '../ioc/types';
import { FileNode } from '../nodes/types';
import { IServerHost, IWorkspaceQueryStateStore } from '../server/types';
import { BranchSelection, IGitServiceFactory } from '../types';
import { command } from './registration';
import { IGitHistoryCommandHandler } from './types';

@injectable()
export class GitHistoryCommandHandler implements IGitHistoryCommandHandler {
    private _server?: IServerHost;
    private get server(): IServerHost {
        if (!this._server) {
            this._server = this.serviceContainer.get<IServerHost>(IServerHost);
            this.disposableRegistry.register(this._server);
        }
        return this._server!;
    }
    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(ICommandManager) private commandManager: ICommandManager) { }

    @command('git.viewFileHistory', IGitHistoryCommandHandler)
    public async viewFileHistory(info?: FileCommitDetails | Uri): Promise<void> {
        let fileUri: Uri | undefined;
        if (info) {
            if (info instanceof FileCommitDetails) {
                const committedFile = info.committedFile;
                fileUri = committedFile.uri ? Uri.file(committedFile.uri!.fsPath!) : Uri.file(committedFile.oldUri!.fsPath);
            } else if (info instanceof FileNode) {
                const committedFile = info.data!.committedFile;
                fileUri = committedFile.uri ? Uri.file(committedFile.uri!.fsPath!) : Uri.file(committedFile.oldUri!.fsPath);
            } else if (info instanceof Uri) {
                fileUri = info;
                // tslint:disable-next-line:no-any
            } else if ((info as any).resourceUri) {
                // tslint:disable-next-line:no-any
                fileUri = (info as any).resourceUri as Uri;
            }
        } else {
            const activeTextEditor = window.activeTextEditor!;
            if (!activeTextEditor || activeTextEditor.document.isUntitled) {
                return;
            }
            fileUri = activeTextEditor.document.uri;
        }
        return this.viewHistory(fileUri);
    }
    @command('git.viewLineHistory', IGitHistoryCommandHandler)
    public async viewLineHistory(): Promise<void> {
        let fileUri: Uri | undefined;
        const activeTextEditor = window.activeTextEditor!;
        if (!activeTextEditor || activeTextEditor.document.isUntitled) {
            return;
        }
        fileUri = activeTextEditor.document.uri;
        const currentLineNumber = activeTextEditor.selection.start.line + 1;
        return this.viewHistory(fileUri, currentLineNumber);
    }
    @command('git.viewHistory', IGitHistoryCommandHandler)
    public async viewBranchHistory(): Promise<void> {
        return this.viewHistory();
    }

    public async viewHistory(fileUri?: Uri, lineNumber?: number): Promise<void> {
        const uiService = this.serviceContainer.get<IUiService>(IUiService);
        const workspaceFolder = await uiService.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            return undefined;
        }
        let gitService = await this.serviceContainer.get<IGitServiceFactory>(IGitServiceFactory).createGitService(workspaceFolder, fileUri ? fileUri.fsPath : workspaceFolder);
        const gitRoots = await gitService.getGitRoots(fileUri ? fileUri.fsPath : workspaceFolder);
        if (gitRoots.length > 1) {
            const selectedGitRoot = gitRoots.length === 0 ? workspaceFolder : (gitRoots.length === 1 ? gitRoots[0]! : await this.selectGitRoot(gitRoots));
            if (!selectedGitRoot) {
                return undefined;
            }
            gitService = await this.serviceContainer.get<IGitServiceFactory>(IGitServiceFactory).createGitService(workspaceFolder, selectedGitRoot);
        }

        const gitRootPromise = gitService.getGitRoot();
        const branchNamePromise = gitService.getCurrentBranch();
        const startupInfoPromise = this.server!.start(workspaceFolder);
        const localePromise = osLocale();
        const gitRootsUnderWorkspacePromise = gitService.getGitRoots(workspaceFolder);

        const [gitRoot, branchName, startupInfo, locale, gitRootsUnderWorkspace] = await Promise.all([gitRootPromise, branchNamePromise, startupInfoPromise, localePromise, gitRootsUnderWorkspacePromise]);

        // Do not include the search string into this
        const fullId = `${startupInfo.port}:${BranchSelection.Current}:${fileUri ? fileUri.fsPath : ''}:${gitRoot}`;
        const id = md5(fullId); //Date.now().toString();
        await this.serviceContainer.get<IWorkspaceQueryStateStore>(IWorkspaceQueryStateStore).initialize(id, workspaceFolder, gitRoot, branchName, BranchSelection.Current, '', fileUri, lineNumber);

        const queryArgs = [
            `id=${id}`, `port=${startupInfo.port}`,
            `file=${fileUri ? encodeURIComponent(fileUri.fsPath) : ''}`,
            `branchSelection=${BranchSelection.Current}`, `locale=${encodeURIComponent(locale)}`
        ];
        queryArgs.push(`branchName=${encodeURIComponent(branchName)}`);
        const uri = `${previewUri}?${queryArgs.join('&')}`;

        const repoName = gitRootsUnderWorkspace.length > 1 ? ` (${path.basename(gitRoot)})` : '';
        let title = fileUri ? `File History (${path.basename(fileUri.fsPath)})` : `Git History ${repoName}`;
        if (fileUri && typeof lineNumber === 'number') {
            title = `Line History (${path.basename(fileUri.fsPath)}#${lineNumber})`;
        }

        this.commandManager.executeCommand('previewHtml', uri, ViewColumn.One, title);
    }
    private async selectGitRoot(gitRoots: string[]) {
        const app = this.serviceContainer.get<IApplicationShell>(IApplicationShell);
        type itemType = QuickPickItem & { gitRoot: string };
        const pickList: itemType[] = gitRoots.map(item => {
            return {
                label: path.basename(item),
                detail: item,
                gitRoot: item
            };
        });
        const options = {
            canPickMany: false, matchOnDescription: true,
            matchOnDetail: true, placeHolder: 'Select a Git Repository'
        };
        const selectedItem = await app.showQuickPick(pickList, options);
        if (selectedItem) {
            return selectedItem.gitRoot;
        }
    }
}
