import fs from "node:fs";
import path from "node:path";

import { git } from "./git-checkouts";
import { workingRepoGit } from "../src/lib/delivery/branches";
import type { DeliveryEnvironment } from "../src/lib/delivery/environment";
import { sameRepository } from "../src/lib/delivery/record";

/** The repository staging fixtures record deliveries for. */
export const PRODUCT = "acme/product";

/**
 * A Working Repository `acme/product` for merge settlement: a bare remote, the developer's clone
 * (`clone`) and a second clone (`other`) that lands merges the way a forge does.
 */
export interface ProductRepo {
  remote: string;
  clone: string;
  /** Commits `file` on `branch` in the developer's clone and pushes it; returns the commit. */
  commitOn(branch: string, file: string, content: string): string;
  /** Squash-merges `origin/<branch>` into `main` from the second clone; returns the squash. */
  squashMerge(branch: string, message: string): string;
}

export function makeProductRepo(root: string): ProductRepo {
  const remote = path.join(root, "product.git");
  const clone = path.join(root, "product");
  const other = path.join(root, "product-other");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", clone);
  git(clone, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(clone, "base.txt"), "base\n");
  git(clone, "add", "base.txt");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "main");
  git(root, "clone", "-q", remote, other);

  return {
    remote,
    clone,
    commitOn(branch, file, content) {
      const exists = git(clone, "branch", "--list", branch).trim() !== "";
      git(clone, "switch", "-q", ...(exists ? [branch] : ["-c", branch]));
      fs.writeFileSync(path.join(clone, file), content);
      git(clone, "add", file);
      git(clone, "commit", "-q", "-m", `${branch}: ${file}`);
      git(clone, "push", "-q", "origin", branch);
      const head = git(clone, "rev-parse", "HEAD").trim();
      git(clone, "switch", "-q", "main");
      return head;
    },
    squashMerge(branch, message) {
      git(other, "fetch", "-q", "origin");
      git(other, "switch", "-q", "main");
      git(other, "reset", "-q", "--hard", "origin/main");
      git(other, "merge", "-q", "--squash", `origin/${branch}`);
      git(other, "commit", "-q", "-m", message);
      git(other, "push", "-q", "origin", "main");
      return git(other, "rev-parse", "HEAD").trim();
    },
  };
}

/** A delivery environment whose only linked checkout is the product clone, in Git mode `auto`. */
export function productEnvironment(
  companionPath: string,
  product: ProductRepo,
): DeliveryEnvironment {
  return {
    companionPath,
    workingRepo: { path: product.clone, slug: PRODUCT, git: workingRepoGit(product.clone) },
    protectedPatterns: [],
    checkoutOf: async (repository) => (sameRepository(repository, PRODUCT) ? product.clone : null),
    gitAutoMode: true,
  };
}
