import type { Request, Response } from 'express';
import { params, query } from '../../middlewares/validate';
import type { UuidParam } from '../../utils/pagination';
import * as postService from './post.service';
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from './post.schema';

export async function list(req: Request, res: Response): Promise<void> {
  const { items, meta } = await postService.listPosts(query<ListPostsQuery>(req), req.user);
  res.json({ success: true, data: items, meta });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const post = await postService.getPostById(params<UuidParam>(req).id, req.user);
  res.json({ success: true, data: { post } });
}

export async function create(req: Request, res: Response): Promise<void> {
  const post = await postService.createPost(req.body as CreatePostInput, req.user!.id);
  res.status(201).json({ success: true, message: 'Post created', data: { post } });
}

export async function update(req: Request, res: Response): Promise<void> {
  const post = await postService.updatePost(
    params<UuidParam>(req).id,
    req.body as UpdatePostInput,
    req.user!,
  );
  res.json({ success: true, message: 'Post updated', data: { post } });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await postService.deletePost(params<UuidParam>(req).id, req.user!);
  res.status(204).send();
}
