import { Octokit } from "octokit";
import path from "path";
import { Repository } from "tiny-commit-walker";
import { inflateRawSync } from "zlib";
import { getGhAppInfo, BaseEventBody, CommentToPrBody, UpdateStatusBody } from "reg-gh-app-interface";
import { fsUtil } from "reg-suit-util";
import { NotifierPlugin, NotifyParams, PluginCreateOptions, PluginLogger } from "reg-suit-interface";

type PrCommentBehavior = "default" | "once" | "new";

export interface GitHubPluginOption {
  clientId?: string;
  installationId?: string;
  owner?: string;
  repository?: string;
  regconfigId?: string;
  prComment?: boolean;
  prCommentBehavior?: PrCommentBehavior;
  setCommitStatus?: boolean;
  customEndpoint?: string;
  shortDescription?: boolean;
}

interface GhAppStatusCodeError {
  name: "StatusCodeError";
  statusCode: number;
  error: {
    message: string;
  };
}

function isGhAppError(x: any): x is GhAppStatusCodeError {
  return x.name && x.name === "StatusCodeError";
}

const errorHandler = (logger: PluginLogger) => {
  return (reason: any) => {
    if (isGhAppError(reason)) {
      logger.error(reason.error.message);
      return Promise.reject(reason.error);
    } else {
      return Promise.reject(reason);
    }
  };
};

export class GitHubNotifierPlugin implements NotifierPlugin<GitHubPluginOption> {
  _logger!: PluginLogger;
  _noEmit!: boolean;
  _apiOpt!: BaseEventBody;
  _prComment!: boolean;
  _setCommitStatus!: boolean;
  _behavior!: PrCommentBehavior;
  _shortDescription!: boolean;
  _regconfigId!: string;

  _apiPrefix!: string;
  _repo!: Repository;
  _octokit!: Octokit;

  _decodeClientId(clientId: string) {
    const tmp = inflateRawSync(new Buffer(clientId, "base64")).toString().split("/");
    if (tmp.length !== 4) {
      this._logger.error(`Invalid client ID: ${this._logger.colors.red(clientId)}`);
      throw new Error(`Invalid client ID: ${clientId}`);
    }
    const [repository, installationId, owner] = tmp.slice(1);
    return { repository, installationId, owner };
  }

  init(config: PluginCreateOptions<GitHubPluginOption>) {
    this._noEmit = config.noEmit;
    this._logger = config.logger;
    if (config.options.clientId) {
      this._apiOpt = this._decodeClientId(config.options.clientId);
    } else {
      this._apiOpt = config.options as BaseEventBody;
    }
    this._prComment = config.options.prComment !== false;
    this._behavior = config.options.prCommentBehavior ?? "default";
    this._setCommitStatus = config.options.setCommitStatus !== false;
    this._shortDescription = config.options.shortDescription ?? false;
    this._regconfigId = config.options.regconfigId ?? "";
    this._apiPrefix = config.options.customEndpoint || getGhAppInfo().endpoint;
    this._repo = new Repository(path.join(fsUtil.prjRootDir(".git"), ".git"));
    // Octokit instance initialization
    this._octokit = new Octokit();
  }

  async notify(params: NotifyParams): Promise<any> {
    const head = this._repo.readHeadSync();
    const { failedItems, newItems, deletedItems, passedItems } = params.comparisonResult;
    const failedItemsCount = failedItems.length;
    const newItemsCount = newItems.length;
    const deletedItemsCount = deletedItems.length;
    const passedItemsCount = passedItems.length;
    const state = failedItemsCount + newItemsCount + deletedItemsCount === 0 ? "success" : "failure";
    const description = state === "success" ? "Regression testing passed" : "Regression testing failed";
    let sha1: string;

    if (head.branch) {
      sha1 = head.branch.commit.hash;
    } else if (head.commit) {
      sha1 = head.commit.hash;
    } else {
      this._logger.error("Can't detect HEAD branch or commit.");
      return Promise.resolve();
    }

    const updateStatusBody: UpdateStatusBody = {
      ...this._apiOpt,
      sha1,
      description,
      state,
    };
    if (params.reportUrl) updateStatusBody.reportUrl = params.reportUrl;
    if (this._prComment) {
      updateStatusBody.metadata = {
        failedItemsCount,
        newItemsCount,
        deletedItemsCount,
        passedItemsCount,
        shortDescription: this._shortDescription,
      };
    }

    if (this._setCommitStatus) {
      try {
        await this._octokit.rest.repos.createCommitStatus({
          owner: this._apiOpt.owner,
          repo: this._apiOpt.repository,
          sha: sha1,
          state,
          description,
          context: "regression-tests",
          target_url: params.reportUrl,
        });
        this._logger.info(`Updated commit status for ${this._logger.colors.green(sha1)} .`);
      } catch (err) {
        const handler = errorHandler(this._logger);
        await handler(err);
      }
    }

    if (this._prComment) {
      if (head.type === "branch" && head.branch) {
        const prCommentBody: CommentToPrBody = {
          ...this._apiOpt,
          behavior: this._behavior,
          branchName: head.branch.name,
          headOid: sha1,
          failedItemsCount,
          newItemsCount,
          deletedItemsCount,
          passedItemsCount,
          shortDescription: this._shortDescription,
          regconfigId: this._regconfigId,
        };

        this._logger.verbose("params.reportUrl: ", params.reportUrl);
        if (params.reportUrl) prCommentBody.reportUrl = params.reportUrl;

        try {
          const pulls = await this._octokit.rest.pulls.list({
            owner: this._apiOpt.owner,
            repo: this._apiOpt.repository,
            head: `${this._apiOpt.owner}:${prCommentBody.branchName}`,
          });

          if (pulls.data.length > 0) {
            const pr = pulls.data[0];
            this._logger.verbose("pr: ", pr);

            await this._octokit.rest.issues.createComment({
              owner: this._apiOpt.owner,
              repo: this._apiOpt.repository,
              issue_number: pr.number,
              body: this._createCommentBody(prCommentBody),
            });
            this._logger.info(
              `Commented on PR ${this._logger.colors.green(
                `${this._apiOpt.owner}/${this._apiOpt.repository}#${pr.number}`,
              )} .`,
            );
          } else {
            this._logger.warn(
              `No pull request found for branch ${this._logger.colors.yellow(prCommentBody.branchName)}.`,
            );
          }
        } catch (err) {
          const handler = errorHandler(this._logger);
          await handler(err);
        }
      } else {
        this._logger.warn(`HEAD is not attached into any branches.`);
      }
    }

    if (this._noEmit) {
      return Promise.resolve();
    }
    const spinner = this._logger.getSpinner("せいせいせいせいsending notification to GitHub...");
    spinner.start();
    spinner.stop();
  }

  // Helper method to create the PR comment body content
  _createCommentBody(body: CommentToPrBody) {
    // implement the method to generate the comment text
    return `Comparison result:
    - Failed items: ${body.failedItemsCount}
    - New items: ${body.newItemsCount}
    - Deleted items: ${body.deletedItemsCount}
    - Passed items: ${body.passedItemsCount}
    ${body.shortDescription ? " - Short descriptions enabled" : ""}
    ${body.reportUrl ? ` - [Report URL](${body.reportUrl})` : ""}`;
  }
}
