# Changelog for code-push-server
## 在本地部署的修改
### code push server 的修改
1、因本地 mysql 版本高于作者指定版本，故将 package.json 中将 mysql2 版本升级为 2.2.5，如果是基于 docker 环境安装，则无需升级 mysql2 版本
2、code push 时会导致 code-push-server 服务挂起，大概原因是目录定位不准确，需要修改 /core/utils/security.js 文件, 将 `relativePath = path.join('CodePush', matchresult[0])`  修改为 `relativePath = path.join("www", matchresult[0])`
3、关于 config.js 的修改：
 - storageDir: 需写一个具体的目录
 - local 中的 downloadUrl 切记不要写 127.0.0.1，写内网的实际 IP
 - tokenSecret 修改
 - common 中 dataDir：需要写一个具体的目录地址

### demo的配置修改
1、index.html 中 meata 标签，可不修改，若修改则： <meta http-equiv="Content-Security-Policy" content="default-src * gap://ready file:; style-src 'self' 'unsafe-inline' *; script-src 'self' 'unsafe-inline' 'unsafe-eval' *; img-src * data: 'unsafe-inline'">  
2、android:usesCleartextTraffic="true"
3、config.xml
```
<platform name="android">
    <allow-intent href="market:*" />
    <preference name="CodePushDeploymentKey" value="cjfa8KXkcB2vBEZmqhO6aYv6gO4z4ksvOXqog" />
    <preference name="CodePushServerUrl" value="http://192.168.13.169:3000/" />
</platform>
<platform name="ios">
    <allow-intent href="itms:*" />
    <allow-intent href="itms-apps:*" />
    <preference name="CodePushDeploymentKey" value="jgXUoZAlORIxEjkxSDg3NBeMH3yN4ksvOXqog" />
    <preference name="CodePushServerUrl" value="http://192.168.13.169:3000/" />
</platform>
```



## 0.5.x

## 新特性
- 针对文本增量更新进行优化，使用google `diff-match-patch` 算法计算差异
   - react-native-code-push Android客户端适配,需要合并https://github.com/Microsoft/react-native-code-push/pull/1393, 才能正常使用文本增量更新功能。
  - react-native-code-push iOS客户端适配 (需要合并https://github.com/Microsoft/react-native-code-push/pull/1399)
  - react-native-code-push Windows客户端适配 (进行中)

## fixbug

- 修复统计数据激活数
- 修复灰度发布bug
- rollback后增加计算和最后一次增量更新版本

## 如何升级到该版本

###  升级数据库

`$ npm run upgrade`

or

`$ code-push-server-db upgrade`


## 0.4.x

### 新特性

- targetBinaryVersion 支持正则匹配, `deployments_versions`新增字段`min_version`,`max_version`
  - `*` 匹配所有版本
  - `1.2.3` 匹配特定版本`1.2.3`
  - `1.2`/`1.2.*` 匹配所有1.2补丁版本 
  - `>=1.2.3<1.3.7`
  - `~1.2.3` 匹配`>=1.2.3<1.3.0`
  - `^1.2.3` 匹配`>=1.2.3<2.0.0`
- 添加docker编排服务部署，更新文档
- Support Tencent cloud cos storageType  

## 如何升级到该版本

-  升级数据库
`$ ./bin/db upgrade`
or
`$ mysql codepush < ./sql/codepush-v0.4.0-patch.sql`

- 处理存量数据
``` shell
   $ git clone https://github.com/lisong/tools
   $ cd tools
   $ npm i
   $ vim ./bin/fixMinMaxVersion //修改数据配置
   $ node  ./bin/fixMinMaxVersion //出现提示 success
```

## 0.3.x

- 支持灰度发布
- 适配`code-push app add` 命令，应用不再以名字区分平台，而是以类型区分平台
  - 数据库表apps新增字段`os`,`platform`
- 完善`code-push release/release-react/release-cordova` 命令
  - 数据库表packages新增`is_disabled`,`rollout`字段
- 适配`code-push patch`命令
- 新增`log_report_download`,`log_report_deploy`日志表
- 升级npm依赖包
